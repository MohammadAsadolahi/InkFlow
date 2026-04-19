import postgres from 'postgres';
import { readNewLines, readHeaderHash } from '../watcher/fileReader';
import { detectFork } from '../parser/forkDetector';
import { computeContentHash } from '../utils/hash';
import { JsonlReplayer } from '../parser/jsonlReplayer';
import { RawEventRepo } from '../db/repos/rawEventRepo';
import { SessionRepo } from '../db/repos/sessionRepo';
import { MessageRepo } from '../db/repos/messageRepo';
import { WatchStateRepo } from '../db/repos/watchStateRepo';
import { WorkspaceRepo } from '../db/repos/workspaceRepo';
import { TurnRepo } from '../db/repos/turnRepo';
import { TurnPartRepo } from '../db/repos/turnPartRepo';
import type { JsonlEntry, RawEventInput, MessageRole } from '../types';

interface Logger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
    debug: (msg: string) => void;
}

interface ProcessorConfig {
    instanceId: string;
    filterInputState: boolean;
}

interface ParsedPart {
    partIndex: number;
    kind: string | null;
    content: string | null;
    rawJson: unknown;
}

/**
 * Main event processing pipeline.
 *
 * File change → read new bytes → parse → store raw events →
 *   replay JSONL → materialize sessions / turns / turn_parts / messages
 *
 * The `turns` + `turn_parts` tables capture every piece of the conversation:
 *   - user text
 *   - agent thinking / reasoning
 *   - tool invocations (file reads, terminal commands, sub-agent calls …)
 *   - file edits applied
 *   - inline references, codeblock URIs, undo stops, MCP lifecycle
 *   - final AI text
 *
 * The `messages` table is kept as a simplified backward-compatible summary.
 */
export class EventProcessor {
    private rawEventRepo: RawEventRepo;
    private sessionRepo: SessionRepo;
    private messageRepo: MessageRepo;
    private watchStateRepo: WatchStateRepo;
    private workspaceRepo: WorkspaceRepo;
    private isShuttingDown = false;

    constructor(
        private sql: postgres.Sql,
        private config: ProcessorConfig,
        private log: Logger,
    ) {
        this.rawEventRepo = new RawEventRepo(sql);
        this.sessionRepo = new SessionRepo(sql);
        this.messageRepo = new MessageRepo(sql);
        this.watchStateRepo = new WatchStateRepo(sql);
        this.workspaceRepo = new WorkspaceRepo(sql);
    }

    /**
     * Process a file change: read new bytes, ingest events, materialize.
     */
    async processFileChange(
        filePath: string,
        workspaceId: number,
    ): Promise<number> {
        if (this.isShuttingDown) return 0;

        // Get current watch state
        const watchState = await this.watchStateRepo.get(filePath);
        const currentOffset = watchState?.last_byte_offset ?? 0;

        // Check for file rewrite via header hash
        const headerHash = await readHeaderHash(filePath);
        if (watchState && headerHash) {
            const storedHash = watchState.header_hash;
            if (storedHash && !Buffer.from(storedHash).equals(headerHash)) {
                // File was rewritten (compaction) — re-read from beginning
                this.log.info(`File rewrite detected (header hash changed): ${filePath}`);
                return await this.processFromOffset(filePath, 0, workspaceId, headerHash);
            }
        }

        return await this.processFromOffset(filePath, currentOffset, workspaceId, headerHash);
    }

    private async processFromOffset(
        filePath: string,
        offset: number,
        workspaceId: number,
        headerHash: Buffer | null,
    ): Promise<number> {
        const result = await readNewLines(filePath, offset, this.config.filterInputState);

        if (result.lines.length === 0) {
            // Still update watch state if we consumed empty lines
            if (result.consumedUpTo > offset) {
                await this.watchStateRepo.upsert(
                    filePath, result.consumedUpTo,
                    headerHash ?? result.headerHash,
                    workspaceId,
                );
            }
            return 0;
        }

        let ingested = 0;

        for (const line of result.lines) {
            const eventInput: RawEventInput = {
                eventHash: line.eventHash,
                workspaceId,
                sessionFile: filePath,
                byteOffset: line.byteOffset,
                kind: line.entry.kind,
                keyPath: 'k' in line.entry && line.entry.k ? line.entry.k.map(String) : null,
                rawContent: JSON.parse(line.rawLine),
                fileMtimeMs: null,
                instanceId: this.config.instanceId,
                batchId: null,
            };

            const eventId = await this.rawEventRepo.insert(eventInput);
            if (eventId !== null) {
                ingested++;
            }
        }

        // Update watch state with consumed offset
        const effectiveHeaderHash = headerHash ?? result.headerHash;
        await this.watchStateRepo.upsert(
            filePath, result.consumedUpTo,
            effectiveHeaderHash,
            workspaceId,
        );

        // Materialize sessions from raw events
        await this.materializeFromFile(filePath, workspaceId);

        return ingested;
    }

    // ─────────────────────────────────────────────────────────────
    // Cursor-driven materialization
    // ─────────────────────────────────────────────────────────────

    async materializeFromFile(sessionFile: string, workspaceId: number): Promise<void> {
        await this.sql.begin(async (tx) => {
            const events = await tx`
                SELECT * FROM raw_events
                WHERE session_file = ${sessionFile}
                ORDER BY id ASC
            `;
            if (events.length === 0) return;

            // ── Resolve session UUID from first kind=0 event ──
            let sessionUuid: string | null = null;
            for (const event of events) {
                if (event.kind === 0) {
                    const content = typeof event.raw_content === 'string'
                        ? JSON.parse(event.raw_content)
                        : event.raw_content;
                    sessionUuid = content.v?.sessionId || content.v?.id || null;
                    break;
                }
            }
            if (!sessionUuid) {
                const filename = sessionFile.split(/[\\/]/).pop()?.replace('.jsonl', '') || sessionFile;
                sessionUuid = filename;
            }

            await tx`SELECT pg_advisory_xact_lock(hashtext(${sessionUuid}))`;
            const sessionId = await this.upsertSession(tx, sessionUuid, workspaceId, sessionFile);

            const [sessionRow] = await tx`
                SELECT last_event_id FROM sessions WHERE id = ${sessionId}
            `;
            const lastEventId = sessionRow?.last_event_id ?? 0;
            const newEvents = events.filter(e => e.id > lastEventId);
            if (newEvents.length === 0) return;

            // ── Apply structural patches (title, fork detection) ──
            for (const event of newEvents) {
                await this.applyStructuralEvent(tx, sessionId, event);
            }

            // ── Replay ALL events to get authoritative final state ──
            // We can't rely on incremental state here because turn_parts must
            // be consistent with the full replayed JSONL at all times.
            const replayer = new JsonlReplayer();
            for (const event of events) {
                const entry = (typeof event.raw_content === 'string'
                    ? JSON.parse(event.raw_content)
                    : event.raw_content) as JsonlEntry;
                replayer.apply(entry);
            }
            const finalState = replayer.getState();
            const rawEventId = newEvents[newEvents.length - 1].id;

            // ── Materialise turns + turn_parts + messages ──
            if (finalState?.requests && Array.isArray(finalState.requests)) {
                const turnRepo = new TurnRepo(tx);
                const partRepo = new TurnPartRepo(tx);

                // Update session title/customTitle from final state
                if (finalState.customTitle || finalState.title) {
                    await tx`
                        UPDATE sessions SET
                            title        = COALESCE(${finalState.title ?? null}, title),
                            custom_title = COALESCE(${finalState.customTitle ?? null}, custom_title)
                        WHERE id = ${sessionId}
                    `;
                }

                for (let i = 0; i < finalState.requests.length; i++) {
                    await this.syncTurn(
                        tx, turnRepo, partRepo,
                        sessionId, i, finalState.requests[i],
                        rawEventId, finalState,
                    );
                }

                await tx`
                    UPDATE sessions
                    SET turn_count = ${finalState.requests.length}, last_modified_at = NOW()
                    WHERE id = ${sessionId}
                `;
            }

            // ── Advance cursor ──
            await tx`
                UPDATE sessions SET last_event_id = ${rawEventId}, last_modified_at = NOW()
                WHERE id = ${sessionId}
            `;
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Structural event: title updates + fork detection
    // ─────────────────────────────────────────────────────────────

    private async applyStructuralEvent(
        tx: postgres.TransactionSql,
        sessionId: number,
        event: postgres.Row,
    ): Promise<void> {
        const rawContent = typeof event.raw_content === 'string'
            ? JSON.parse(event.raw_content)
            : event.raw_content;
        const entry: JsonlEntry = rawContent;

        if (entry.kind === 1) {
            const k = entry.k;
            if (k.length === 1 && k[0] === 'title') {
                await tx`UPDATE sessions SET title = ${String(entry.v)}, last_modified_at = NOW() WHERE id = ${sessionId}`;
            } else if (k.length === 1 && k[0] === 'customTitle') {
                await tx`UPDATE sessions SET custom_title = ${String(entry.v)}, last_modified_at = NOW() WHERE id = ${sessionId}`;
            }
            return;
        }

        if (entry.kind === 2) {
            const [sessionRow] = await tx`SELECT turn_count FROM sessions WHERE id = ${sessionId}`;
            const currentTurnCount = sessionRow?.turn_count ?? 0;
            const fork = detectFork(entry, currentTurnCount);
            if (fork) {
                // Soft-delete everything from forkAt onwards; turns will be
                // rebuilt from final replayed state below.
                await tx`
                    UPDATE messages
                    SET deleted_at = NOW(), deletion_reason = 'forked'
                    WHERE session_id = ${sessionId}
                      AND request_index >= ${fork.forkAt}
                      AND deleted_at IS NULL
                `;
                await tx`
                    UPDATE turns
                    SET deleted_at = NOW()
                    WHERE session_id = ${sessionId}
                      AND turn_index >= ${fork.forkAt}
                      AND deleted_at IS NULL
                `;
                await tx`
                    UPDATE sessions SET
                        fork_count = fork_count + 1,
                        version    = version + 1
                    WHERE id = ${sessionId}
                `;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Sync one turn (upsert turn + replace all parts + sync messages)
    // ─────────────────────────────────────────────────────────────

    private async syncTurn(
        tx: postgres.TransactionSql,
        turnRepo: TurnRepo,
        partRepo: TurnPartRepo,
        sessionId: number,
        turnIndex: number,
        req: any,
        rawEventId: number,
        fullState: any,
    ): Promise<void> {
        const userText = req?.message?.text || req?.message?.content || '';
        const modelId = req?.modelId || fullState?.modelId || null;
        const agentId = req?.agent?.id || null;
        const mode = req?.agent?.modes?.[0] || null;
        const tsMs = typeof req?.timestamp === 'number' ? req.timestamp : null;
        const doneMs = typeof req?.modelState?.completedAt === 'number'
            ? req.modelState.completedAt : null;

        const turnId = await turnRepo.upsert({
            sessionId,
            turnIndex,
            requestId: req?.requestId ?? null,
            responseId: req?.responseId ?? null,
            timestampMs: tsMs,
            completedAtMs: doneMs,
            modelId,
            agentId,
            mode,
            userText,
            userRaw: req?.message ?? null,
        });

        // Parse every response part
        const parts = this.parseResponseParts(req?.response);
        await partRepo.replaceAll(turnId, parts);

        // Keep messages table in sync (backward-compat summary)
        await this.syncMessagesForTurn(tx, sessionId, turnIndex, userText, parts, rawEventId);
    }

    // ─────────────────────────────────────────────────────────────
    // Parse the response array into typed parts
    // ─────────────────────────────────────────────────────────────

    private parseResponseParts(response: any): ParsedPart[] {
        if (!response || !Array.isArray(response)) return [];

        return response.map((part: any, idx: number): ParsedPart => {
            const kind: string | null = part?.kind ?? null;
            let content: string | null = null;

            if (kind === null && typeof part?.value === 'string') {
                // Plain text chunk
                content = part.value;
            } else if (kind === 'thinking' && typeof part?.value === 'string') {
                // Agent reasoning
                content = part.value;
            } else if (kind === 'toolInvocationSerialized') {
                // Tool / sub-agent call — capture invocation message
                const msg = part?.invocationMessage?.value || part?.pastTenseMessage?.value;
                content = typeof msg === 'string' ? msg : null;
            } else if (kind === 'textEditGroup') {
                // File edit — capture the file path
                const uri = part?.uri?.fsPath || part?.uri?.path;
                content = typeof uri === 'string' ? uri : null;
            } else if (kind === 'inlineReference') {
                // Code / symbol reference
                const name = part?.inlineReference?.name || part?.inlineReference?.uri?.fsPath;
                content = typeof name === 'string' ? name : null;
            } else if (kind === 'codeblockUri') {
                const uri = part?.uri?.fsPath || part?.uri?.path;
                content = typeof uri === 'string' ? uri : null;
            }

            return { partIndex: idx, kind, content, rawJson: part };
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Keep the `messages` table (backward-compat) in sync
    // ─────────────────────────────────────────────────────────────

    private async syncMessagesForTurn(
        tx: postgres.TransactionSql,
        sessionId: number,
        requestIndex: number,
        userText: string,
        parts: ParsedPart[],
        rawEventId: number,
    ): Promise<void> {
        // ── User message ──
        const userHash = computeContentHash(userText);
        const [existingUser] = await tx`
            SELECT id FROM messages
            WHERE session_id = ${sessionId}
              AND request_index = ${requestIndex}
              AND role = 'user'
              AND deleted_at IS NULL
        `;
        if (!existingUser) {
            const uid = await this.createMessage(tx, sessionId, requestIndex, 'user', userText, userHash);
            await this.addVersion(tx, uid, 1, userText, userHash, 'created', rawEventId);
        }

        // ── Assistant summary (all text + thinking) ──
        const assistantText = parts
            .filter(p => p.kind === null || p.kind === 'thinking')
            .map(p => p.content ?? '')
            .filter(Boolean)
            .join('');

        if (!assistantText) return;

        const assistantHash = computeContentHash(assistantText);
        const [existingAssistant] = await tx`
            SELECT id, content_hash FROM messages
            WHERE session_id = ${sessionId}
              AND request_index = ${requestIndex}
              AND role = 'assistant'
              AND deleted_at IS NULL
        `;

        if (!existingAssistant) {
            const aid = await this.createMessage(
                tx, sessionId, requestIndex, 'assistant', assistantText, assistantHash,
            );
            await this.addVersion(tx, aid, 1, assistantText, assistantHash, 'created', rawEventId);
        } else if (!Buffer.from(existingAssistant.content_hash).equals(assistantHash)) {
            const [lastVer] = await tx`
                SELECT MAX(version) AS v FROM message_versions WHERE message_id = ${existingAssistant.id}
            `;
            const nextVersion = (lastVer?.v ?? 1) + 1;
            await tx`
                UPDATE messages
                SET content = ${assistantText}, content_hash = ${assistantHash}, finalized_at = NOW()
                WHERE id = ${existingAssistant.id}
            `;
            await this.addVersion(
                tx, existingAssistant.id, nextVersion,
                assistantText, assistantHash, 'finalized', rawEventId,
            );
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────

    private async upsertSession(
        tx: postgres.TransactionSql,
        sessionUuid: string,
        workspaceId: number,
        sourceFile: string,
    ): Promise<number> {
        const [row] = await tx`
            INSERT INTO sessions (session_uuid, workspace_id, source_file)
            VALUES (${sessionUuid}, ${workspaceId}, ${sourceFile})
            ON CONFLICT (session_uuid) DO UPDATE SET
                last_modified_at = NOW(),
                source_file = EXCLUDED.source_file
            RETURNING id
        `;
        return row.id;
    }

    private async createMessage(
        tx: postgres.TransactionSql,
        sessionId: number,
        requestIndex: number,
        role: MessageRole,
        content: string,
        contentHash: Buffer,
    ): Promise<number> {
        const [row] = await tx`
            INSERT INTO messages (session_id, request_index, role, content, content_hash)
            VALUES (${sessionId}, ${requestIndex}, ${role}, ${content}, ${contentHash})
            RETURNING id
        `;
        return row.id;
    }

    private async addVersion(
        tx: postgres.TransactionSql,
        messageId: number,
        version: number,
        content: string,
        contentHash: Buffer,
        changeType: string,
        rawEventId: number,
    ): Promise<void> {
        await tx`
            INSERT INTO message_versions (message_id, version, content, content_hash, change_type, raw_event_id)
            VALUES (${messageId}, ${version}, ${content}, ${contentHash}, ${changeType}, ${rawEventId})
            ON CONFLICT (message_id, version) DO NOTHING
        `;
    }

    shutdown(): void {
        this.isShuttingDown = true;
    }
}
