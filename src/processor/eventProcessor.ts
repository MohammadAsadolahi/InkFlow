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

/**
 * Main event processing pipeline.
 * File change → read new bytes → parse → store raw events → materialize sessions/messages
 */
export class EventProcessor {
    private rawEventRepo: RawEventRepo;
    private sessionRepo: SessionRepo;
    private messageRepo: MessageRepo;
    private watchStateRepo: WatchStateRepo;
    private workspaceRepo: WorkspaceRepo;
    private streamingTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

    /**
     * Cursor-driven materialization: process all unmaterialized events for sessions in this file.
     */
    async materializeFromFile(sessionFile: string, workspaceId: number): Promise<void> {
        // Find all sessions sourced from this file
        // For a given JSONL file, we need to extract the session UUID from the kind=0 event
        await this.sql.begin(async (tx) => {
            // Get unmaterialized events
            const events = await tx`
                SELECT * FROM raw_events
                WHERE session_file = ${sessionFile}
                ORDER BY id ASC
            `;

            if (events.length === 0) return;

            // Find session UUID from kind=0 event
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
                // Use filename as fallback UUID
                const filename = sessionFile.split(/[\\/]/).pop()?.replace('.jsonl', '') || sessionFile;
                sessionUuid = filename;
            }

            // Lock session for materialization
            await tx`SELECT pg_advisory_xact_lock(hashtext(${sessionUuid}))`;

            // Upsert session
            const sessionId = await this.upsertSession(tx, sessionUuid, workspaceId, sessionFile);

            // Get cursor
            const [session] = await tx`
                SELECT last_event_id, turn_count FROM sessions WHERE id = ${sessionId}
            `;
            const lastEventId = session?.last_event_id ?? 0;

            // Get unmaterialized events
            const newEvents = events.filter(e => e.id > lastEventId);
            if (newEvents.length === 0) return;

            // Process each event
            for (const event of newEvents) {
                await this.applyEvent(tx, sessionId, sessionUuid, event);
            }

            // Replay the full file state to sync assistant messages.
            // Response content arrives as kind=2 patches on requests[N].response
            // which applyEvent intentionally skips during streaming. After all
            // new events are processed, replay everything to get the final state
            // and upsert any assistant messages that now have content.
            const replayer = new JsonlReplayer();
            for (const event of events) {
                const entry = (typeof event.raw_content === 'string'
                    ? JSON.parse(event.raw_content)
                    : event.raw_content) as JsonlEntry;
                replayer.apply(entry);
            }
            const finalState = replayer.getState();
            if (finalState?.requests && Array.isArray(finalState.requests)) {
                for (let i = 0; i < finalState.requests.length; i++) {
                    await this.syncAssistantMessage(
                        tx, sessionId, i, finalState.requests[i],
                        newEvents[newEvents.length - 1].id,
                    );
                }
            }

            // Advance cursor
            const maxEventId = newEvents[newEvents.length - 1].id;
            await tx`
                UPDATE sessions SET last_event_id = ${maxEventId}, last_modified_at = NOW()
                WHERE id = ${sessionId}
            `;
        });
    }

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

    private async applyEvent(
        tx: postgres.TransactionSql,
        sessionId: number,
        sessionUuid: string,
        event: postgres.Row,
    ): Promise<void> {
        const rawContent = typeof event.raw_content === 'string'
            ? JSON.parse(event.raw_content)
            : event.raw_content;
        const entry: JsonlEntry = rawContent;

        if (entry.kind === 0) {
            // Initial state — extract session metadata + messages
            await this.handleInitialState(tx, sessionId, entry.v as any, event.id);
            return;
        }

        if (entry.kind === 1) {
            // Set — handle title/customTitle updates
            const k = entry.k;
            if (k.length === 1 && k[0] === 'title') {
                await tx`UPDATE sessions SET title = ${String(entry.v)}, last_modified_at = NOW() WHERE id = ${sessionId}`;
            } else if (k.length === 1 && k[0] === 'customTitle') {
                await tx`UPDATE sessions SET custom_title = ${String(entry.v)}, last_modified_at = NOW() WHERE id = ${sessionId}`;
            }
            return;
        }

        if (entry.kind === 2) {
            // Check for fork
            const [sessionRow] = await tx`SELECT turn_count FROM sessions WHERE id = ${sessionId}`;
            const currentTurnCount = sessionRow?.turn_count ?? 0;

            const fork = detectFork(entry, currentTurnCount);
            if (fork) {
                await this.handleFork(tx, sessionId, fork.forkAt, fork.newItems, event.id);
                return;
            }

            // Check if this is a top-level requests push (new turn)
            if (entry.k.length === 1 && entry.k[0] === 'requests' && entry.v && entry.v.length > 0) {
                await this.handleNewTurns(tx, sessionId, entry.v, currentTurnCount, event.id);
                return;
            }

            // Response streaming update or other sub-path update — log as version
            // (Don't update messages.content during streaming)
            return;
        }

        // kind=3 — delete property — rare, just log
    }

    private async handleInitialState(
        tx: postgres.TransactionSql,
        sessionId: number,
        state: any,
        rawEventId: number,
    ): Promise<void> {
        if (!state || typeof state !== 'object') return;

        // Update session metadata
        if (state.title || state.customTitle) {
            await tx`
                UPDATE sessions SET
                    title = COALESCE(${state.title ?? null}, title),
                    custom_title = COALESCE(${state.customTitle ?? null}, custom_title),
                    last_modified_at = NOW()
                WHERE id = ${sessionId}
            `;
        }

        // Process requests array
        const requests = state.requests;
        if (!Array.isArray(requests)) return;

        for (let i = 0; i < requests.length; i++) {
            const req = requests[i];
            await this.upsertMessage(tx, sessionId, i, req, rawEventId);
        }

        await tx`
            UPDATE sessions SET turn_count = ${requests.length}, last_modified_at = NOW()
            WHERE id = ${sessionId}
        `;
    }

    private async upsertMessage(
        tx: postgres.TransactionSql,
        sessionId: number,
        requestIndex: number,
        request: any,
        rawEventId: number,
    ): Promise<void> {
        const userContent = request?.message?.content || request?.message?.text || '';
        const assistantContent = this.extractResponseContent(request?.response);

        // User message
        const userHash = computeContentHash(userContent);
        const [existingUser] = await tx`
            SELECT id FROM messages
            WHERE session_id = ${sessionId} AND request_index = ${requestIndex} AND role = 'user' AND deleted_at IS NULL
        `;

        if (!existingUser) {
            const userId = await this.createMessage(tx, sessionId, requestIndex, 'user', userContent, userHash);
            await this.addVersion(tx, userId, 1, userContent, userHash, 'created', rawEventId);
        }

        // Assistant message (if response exists)
        if (assistantContent) {
            const assistantHash = computeContentHash(assistantContent);
            const [existingAssistant] = await tx`
                SELECT id FROM messages
                WHERE session_id = ${sessionId} AND request_index = ${requestIndex} AND role = 'assistant' AND deleted_at IS NULL
            `;

            if (!existingAssistant) {
                const assistantId = await this.createMessage(tx, sessionId, requestIndex, 'assistant', assistantContent, assistantHash);
                await this.addVersion(tx, assistantId, 1, assistantContent, assistantHash, 'created', rawEventId);
            }
        }
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

    private async handleNewTurns(
        tx: postgres.TransactionSql,
        sessionId: number,
        newItems: unknown[],
        currentTurnCount: number,
        rawEventId: number,
    ): Promise<void> {
        for (let i = 0; i < newItems.length; i++) {
            const requestIndex = currentTurnCount + i;
            const req = newItems[i] as any;
            await this.upsertMessage(tx, sessionId, requestIndex, req, rawEventId);
        }

        await tx`
            UPDATE sessions SET turn_count = ${currentTurnCount + newItems.length}, last_modified_at = NOW()
            WHERE id = ${sessionId}
        `;
    }

    private async handleFork(
        tx: postgres.TransactionSql,
        sessionId: number,
        forkAt: number,
        newItems: unknown[],
        rawEventId: number,
    ): Promise<void> {
        // 1. Soft-delete all messages at request_index >= forkAt
        await tx`
            UPDATE messages
            SET deleted_at = NOW(), deletion_reason = 'forked'
            WHERE session_id = ${sessionId}
              AND request_index >= ${forkAt}
              AND deleted_at IS NULL
        `;

        // 2. Create new messages from fork items
        for (let i = 0; i < newItems.length; i++) {
            const requestIndex = forkAt + i;
            const req = newItems[i] as any;

            const userContent = req?.message?.content || req?.message?.text || '';
            const userHash = computeContentHash(userContent);
            const userId = await this.createMessage(tx, sessionId, requestIndex, 'user', userContent, userHash);
            await this.addVersion(tx, userId, 1, userContent, userHash, 'forked', rawEventId);

            const assistantContent = this.extractResponseContent(req?.response);
            if (assistantContent) {
                const assistantHash = computeContentHash(assistantContent);
                const assistantId = await this.createMessage(tx, sessionId, requestIndex, 'assistant', assistantContent, assistantHash);
                await this.addVersion(tx, assistantId, 1, assistantContent, assistantHash, 'forked', rawEventId);
            }
        }

        // 3. Update session
        await tx`
            UPDATE sessions SET
                turn_count = ${forkAt + newItems.length},
                fork_count = fork_count + 1,
                version = version + 1,
                last_modified_at = NOW()
            WHERE id = ${sessionId}
        `;
    }

    private extractResponseContent(response: any): string {
        if (!response) return '';
        if (typeof response === 'string') return response;

        // VS Code chat response format: the response field is an array of parts.
        // Text parts have kind=undefined with a `value` string.
        // Thinking parts have kind='thinking' with a `value` string.
        if (Array.isArray(response)) {
            return response
                .filter((part: any) => part && (part.kind === undefined || part.kind === 'thinking') && typeof part.value === 'string')
                .map((part: any) => part.value)
                .filter(Boolean)
                .join('');
        }

        // Fallback for older/alternate formats
        if (response.value) return response.value;
        if (response.result) return typeof response.result === 'string' ? response.result : '';
        return '';
    }

    private async syncAssistantMessage(
        tx: postgres.TransactionSql,
        sessionId: number,
        requestIndex: number,
        request: any,
        rawEventId: number,
    ): Promise<void> {
        const assistantContent = this.extractResponseContent(request?.response);
        if (!assistantContent) return;

        const assistantHash = computeContentHash(assistantContent);
        const [existing] = await tx`
            SELECT id, content_hash FROM messages
            WHERE session_id = ${sessionId}
              AND request_index = ${requestIndex}
              AND role = 'assistant'
              AND deleted_at IS NULL
        `;

        if (!existing) {
            const assistantId = await this.createMessage(
                tx, sessionId, requestIndex, 'assistant', assistantContent, assistantHash,
            );
            await this.addVersion(tx, assistantId, 1, assistantContent, assistantHash, 'created', rawEventId);
        } else if (!Buffer.from(existing.content_hash).equals(assistantHash)) {
            // Content changed — update the message and record a new version
            const [lastVersion] = await tx`
                SELECT MAX(version) AS v FROM message_versions WHERE message_id = ${existing.id}
            `;
            const nextVersion = (lastVersion?.v ?? 1) + 1;
            await tx`
                UPDATE messages
                SET content = ${assistantContent}, content_hash = ${assistantHash}, finalized_at = NOW()
                WHERE id = ${existing.id}
            `;
            await this.addVersion(tx, existing.id, nextVersion, assistantContent, assistantHash, 'updated', rawEventId);
        }
    }

    shutdown(): void {
        this.isShuttingDown = true;
        for (const [, timer] of this.streamingTimers) {
            clearTimeout(timer);
        }
        this.streamingTimers.clear();
    }
}
