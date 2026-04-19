/**
 * End-to-end integration test.
 *
 * Exercises the full pipeline:
 *   JSONL file on disk → fileReader → eventProcessor → PostgreSQL
 *   → verify raw_events, sessions, messages, message_versions
 *   → verify fork handling (soft-delete + re-create)
 *   → verify deduplication (replay same file = no new events)
 *   → verify watch_state offset tracking
 *   → verify title updates
 *
 * Requires: PostgreSQL on localhost:5434 (docker compose up)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import postgres from 'postgres';
import { runMigrations } from '../../src/db/migrations';
import { EventProcessor } from '../../src/processor/eventProcessor';
import { WorkspaceRepo } from '../../src/db/repos/workspaceRepo';

const TEST_DB_URL = process.env.INKFLOW_TEST_DATABASE_URL
    ?? 'postgres://inkflow:inkflow_dev@localhost:5434/inkflow';

let sql: postgres.Sql;
let tmpDir: string;
let workspaceId: number;
const instanceId = crypto.randomUUID();

const log = {
    info: (_msg: string) => { },
    warn: (_msg: string) => { },
    error: (_msg: string, _err?: unknown) => { },
    debug: (_msg: string) => { },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write JSONL lines to a temp file and return the absolute path */
function writeJsonlFile(filename: string, entries: unknown[]): string {
    const filePath = path.join(tmpDir, filename);
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

/** Append JSONL lines to an existing file */
function appendJsonlLines(filePath: string, entries: unknown[]): void {
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(filePath, content, 'utf8');
}

/** Build a realistic kind=0 (initial state) entry */
function makeInitialState(sessionId: string, requests: unknown[] = []) {
    return {
        kind: 0,
        v: {
            sessionId,
            title: 'Test Session',
            requests,
        },
    };
}

/** Build a realistic chat request object */
function makeRequest(userText: string, assistantText?: string) {
    const req: any = {
        message: { content: userText },
    };
    if (assistantText) {
        req.response = {
            parts: [{ kind: 'markdownContent', content: { value: assistantText } }],
        };
    }
    return req;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
    // Connect to test database
    sql = postgres(TEST_DB_URL, {
        max: 3,
        idle_timeout: 30,
        connect_timeout: 10,
    });

    // Verify connection
    const [{ ok }] = await sql`SELECT 1 AS ok`;
    expect(ok).toBe(1);

    // Run migrations
    await runMigrations(sql, log);

    // Create temp dir for JSONL files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-e2e-'));
});

afterAll(async () => {
    // Clean up temp files
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    // Close connection
    await sql.end({ timeout: 3 });
});

beforeEach(async () => {
    // Clean all tables in reverse-dependency order
    await sql`DELETE FROM message_versions`;
    await sql`DELETE FROM messages`;
    await sql`DELETE FROM session_snapshots`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM raw_events`;
    await sql`DELETE FROM watch_state`;
    await sql`DELETE FROM extension_instances`;
    await sql`DELETE FROM workspaces`;

    // Create a test workspace
    const wsRepo = new WorkspaceRepo(sql);
    workspaceId = await wsRepo.upsert('test-hash-e2e', 'stable', 'file:///test', 'Test Workspace');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Full pipeline', () => {

    it('ingests a new session with 2 turns from kind=0', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session1.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Hello AI', 'Hi there! How can I help?'),
                makeRequest('Explain TypeScript', 'TypeScript is a typed superset of JavaScript...'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // Process the file
        const ingested = await processor.processFileChange(filePath, workspaceId);

        // Should have ingested 1 raw event (the kind=0 line)
        expect(ingested).toBe(1);

        // Verify raw_events
        const rawEvents = await sql`SELECT * FROM raw_events WHERE session_file = ${filePath} ORDER BY id`;
        expect(rawEvents).toHaveLength(1);
        expect(rawEvents[0].kind).toBe(0);
        expect(rawEvents[0].workspace_id).toBe(workspaceId);

        // Verify session was created
        const sessions = await sql`SELECT * FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Test Session');
        expect(sessions[0].turn_count).toBe(2);
        expect(sessions[0].fork_count).toBe(0);

        // Verify messages: 2 user + 2 assistant = 4 messages
        const messages = await sql`
            SELECT * FROM messages
            WHERE session_id = ${sessions[0].id} AND deleted_at IS NULL
            ORDER BY request_index, role
        `;
        expect(messages).toHaveLength(4);

        // Turn 0
        expect(messages[0].request_index).toBe(0);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].content).toContain('Hi there');
        expect(messages[1].request_index).toBe(0);
        expect(messages[1].role).toBe('user');
        expect(messages[1].content).toBe('Hello AI');

        // Turn 1
        expect(messages[2].request_index).toBe(1);
        expect(messages[2].role).toBe('assistant');
        expect(messages[2].content).toContain('TypeScript is a typed superset');
        expect(messages[3].request_index).toBe(1);
        expect(messages[3].role).toBe('user');
        expect(messages[3].content).toBe('Explain TypeScript');

        // Verify message_versions — each message should have exactly 1 version
        const versions = await sql`
            SELECT mv.* FROM message_versions mv
            JOIN messages m ON m.id = mv.message_id
            WHERE m.session_id = ${sessions[0].id}
            ORDER BY mv.message_id, mv.version
        `;
        expect(versions).toHaveLength(4);
        versions.forEach((v: any) => {
            expect(v.version).toBe(1);
            expect(v.change_type).toBe('created');
        });

        // Verify watch_state was updated
        const watchState = await sql`SELECT * FROM watch_state WHERE file_path = ${filePath}`;
        expect(watchState).toHaveLength(1);
        expect(Number(watchState[0].last_byte_offset)).toBeGreaterThan(0);
    });

    it('appends a new turn (kind=2 push) after initial state', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session2.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('First question', 'First answer'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // First pass: ingest initial state
        await processor.processFileChange(filePath, workspaceId);

        // Append a new turn via kind=2 (push to requests array)
        appendJsonlLines(filePath, [
            {
                kind: 2,
                k: ['requests'],
                v: [makeRequest('Second question', 'Second answer')],
            },
        ]);

        // Second pass: ingest the new turn
        const ingested = await processor.processFileChange(filePath, workspaceId);
        expect(ingested).toBe(1);

        // Verify session now has 2 turns
        const [session] = await sql`SELECT * FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(session.turn_count).toBe(2);

        // Verify 4 active messages (2 turns × 2 roles)
        const messages = await sql`
            SELECT * FROM messages
            WHERE session_id = ${session.id} AND deleted_at IS NULL
            ORDER BY request_index, role
        `;
        expect(messages).toHaveLength(4);
        expect(messages[2].content).toContain('Second answer');
        expect(messages[3].content).toBe('Second question');
    });

    it('detects a fork and soft-deletes replaced messages', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session-fork.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Turn 0', 'Response 0'),
                makeRequest('Turn 1', 'Response 1'),
                makeRequest('Turn 2 — will be forked', 'Response 2 — will be forked'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // First pass: ingest 3 turns
        await processor.processFileChange(filePath, workspaceId);

        const [sessionBefore] = await sql`SELECT * FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(sessionBefore.turn_count).toBe(3);
        expect(sessionBefore.fork_count).toBe(0);

        // Fork: truncate to 2 turns, push a new replacement turn
        // This is kind=2 with k=['requests'], i=2 (truncate), v=[new turn]
        appendJsonlLines(filePath, [
            {
                kind: 2,
                k: ['requests'],
                i: 2,
                v: [makeRequest('Turn 2 — FORKED replacement', 'Response 2 — FORKED')],
            },
        ]);

        // Second pass: should detect fork
        const ingested = await processor.processFileChange(filePath, workspaceId);
        expect(ingested).toBe(1);

        // Verify session state
        const [sessionAfter] = await sql`SELECT * FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(sessionAfter.turn_count).toBe(3); // still 3 turns (2 kept + 1 new)
        expect(sessionAfter.fork_count).toBe(1);

        // Verify soft-deleted messages (the old turn 2)
        const deletedMsgs = await sql`
            SELECT * FROM messages
            WHERE session_id = ${sessionAfter.id} AND deleted_at IS NOT NULL
            ORDER BY request_index, role
        `;
        expect(deletedMsgs.length).toBeGreaterThanOrEqual(2); // user + assistant for turn 2
        deletedMsgs.forEach((m: any) => {
            expect(m.request_index).toBe(2);
            expect(m.deletion_reason).toBe('forked');
        });

        // Verify new active messages at turn 2
        const activeMsgs = await sql`
            SELECT * FROM messages
            WHERE session_id = ${sessionAfter.id} AND deleted_at IS NULL AND request_index = 2
            ORDER BY role
        `;
        expect(activeMsgs).toHaveLength(2);
        expect(activeMsgs.find((m: any) => m.role === 'user').content).toContain('FORKED replacement');
        expect(activeMsgs.find((m: any) => m.role === 'assistant').content).toContain('FORKED');

        // Verify forked message_versions have change_type = 'forked'
        const forkedVersions = await sql`
            SELECT mv.* FROM message_versions mv
            JOIN messages m ON m.id = mv.message_id
            WHERE m.session_id = ${sessionAfter.id}
              AND m.request_index = 2
              AND m.deleted_at IS NULL
        `;
        forkedVersions.forEach((v: any) => {
            expect(v.change_type).toBe('forked');
        });
    });

    it('deduplicates: replaying the same file produces no new events', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session-dedup.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Hello', 'Hi'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // First pass
        const first = await processor.processFileChange(filePath, workspaceId);
        expect(first).toBe(1);

        // Count raw events
        const [{ count: countAfterFirst }] = await sql`
            SELECT count(*)::int AS count FROM raw_events WHERE session_file = ${filePath}
        `;
        expect(countAfterFirst).toBe(1);

        // Reset watch state to simulate re-read from beginning
        await sql`UPDATE watch_state SET last_byte_offset = 0 WHERE file_path = ${filePath}`;

        // Second pass: same file, same content — should be dedup'd
        const second = await processor.processFileChange(filePath, workspaceId);
        expect(second).toBe(0); // hash-based dedup: ON CONFLICT DO NOTHING

        // Raw events count unchanged
        const [{ count: countAfterSecond }] = await sql`
            SELECT count(*)::int AS count FROM raw_events WHERE session_file = ${filePath}
        `;
        expect(countAfterSecond).toBe(1);
    });

    it('tracks watch_state offsets correctly across reads', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session-offset.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Q1', 'A1'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // First read
        await processor.processFileChange(filePath, workspaceId);

        const [ws1] = await sql`SELECT last_byte_offset FROM watch_state WHERE file_path = ${filePath}`;
        const offset1 = Number(ws1.last_byte_offset);
        expect(offset1).toBeGreaterThan(0);

        // File size should match offset (we read everything)
        const stat1 = fs.statSync(filePath);
        expect(offset1).toBe(stat1.size);

        // Append more data
        appendJsonlLines(filePath, [
            { kind: 1, k: ['title'], v: 'Updated Title' },
        ]);

        // Second read — should only read new bytes
        await processor.processFileChange(filePath, workspaceId);

        const [ws2] = await sql`SELECT last_byte_offset FROM watch_state WHERE file_path = ${filePath}`;
        const offset2 = Number(ws2.last_byte_offset);
        expect(offset2).toBeGreaterThan(offset1);

        // Offset should now match new file size
        const stat2 = fs.statSync(filePath);
        expect(offset2).toBe(stat2.size);
    });

    it('updates session title via kind=1 set', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session-title.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Q', 'A'),
            ]),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // First pass
        await processor.processFileChange(filePath, workspaceId);

        const [before] = await sql`SELECT title FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(before.title).toBe('Test Session');

        // Append title update
        appendJsonlLines(filePath, [
            { kind: 1, k: ['title'], v: 'My New Title' },
        ]);

        // Second pass
        await processor.processFileChange(filePath, workspaceId);

        const [after] = await sql`SELECT title FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(after.title).toBe('My New Title');
    });

    it('filters inputState noise events', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;
        const filePath = writeJsonlFile('session-noise.jsonl', [
            makeInitialState(sessionUuid, [
                makeRequest('Q', 'A'),
            ]),
            // inputState noise — should be filtered
            { kind: 1, k: ['inputState', 'text'], v: 'partial typing...' },
            { kind: 2, k: ['inputState', 'tokens'], v: ['tok1'] },
            // Legitimate title update — should NOT be filtered
            { kind: 1, k: ['title'], v: 'Real Update' },
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);
        const ingested = await processor.processFileChange(filePath, workspaceId);

        // Should ingest kind=0 + kind=1 title, but NOT the 2 inputState entries
        expect(ingested).toBe(2);

        const rawEvents = await sql`SELECT kind, key_path FROM raw_events WHERE session_file = ${filePath} ORDER BY id`;
        expect(rawEvents).toHaveLength(2);
        expect(rawEvents[0].kind).toBe(0);
        expect(rawEvents[1].kind).toBe(1);
    });

    it('handles multi-turn incremental conversation', async () => {
        const sessionUuid = `session-${crypto.randomUUID()}`;

        // Start with empty session
        const filePath = writeJsonlFile('session-incremental.jsonl', [
            makeInitialState(sessionUuid, []),
        ]);

        const processor = new EventProcessor(sql, { instanceId, filterInputState: true }, log);

        // Pass 1: empty session
        await processor.processFileChange(filePath, workspaceId);
        const [s1] = await sql`SELECT turn_count FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(s1.turn_count).toBe(0);

        // Pass 2: add first turn
        appendJsonlLines(filePath, [
            { kind: 2, k: ['requests'], v: [makeRequest('Turn 1', 'Response 1')] },
        ]);
        await processor.processFileChange(filePath, workspaceId);
        const [s2] = await sql`SELECT turn_count FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(s2.turn_count).toBe(1);

        // Pass 3: add second turn
        appendJsonlLines(filePath, [
            { kind: 2, k: ['requests'], v: [makeRequest('Turn 2', 'Response 2')], i: 1 },
        ]);
        await processor.processFileChange(filePath, workspaceId);
        const [s3] = await sql`SELECT turn_count FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(s3.turn_count).toBe(2);

        // Pass 4: add third turn
        appendJsonlLines(filePath, [
            { kind: 2, k: ['requests'], v: [makeRequest('Turn 3', 'Response 3')], i: 2 },
        ]);
        await processor.processFileChange(filePath, workspaceId);
        const [s4] = await sql`SELECT turn_count FROM sessions WHERE session_uuid = ${sessionUuid}`;
        expect(s4.turn_count).toBe(3);

        // Verify all 6 messages are active (3 turns × 2 roles)
        const [session] = await sql`SELECT id FROM sessions WHERE session_uuid = ${sessionUuid}`;
        const msgs = await sql`
            SELECT * FROM messages WHERE session_id = ${session.id} AND deleted_at IS NULL
            ORDER BY request_index, role
        `;
        expect(msgs).toHaveLength(6);
    });

    it('workspace upsert is idempotent', async () => {
        const wsRepo = new WorkspaceRepo(sql);

        const id1 = await wsRepo.upsert('hash-idempotent', 'stable', 'file:///a', 'WS A');
        const id2 = await wsRepo.upsert('hash-idempotent', 'stable', 'file:///a', 'WS A');

        expect(id1).toBe(id2);

        const [{ count }] = await sql`
            SELECT count(*)::int AS count FROM workspaces WHERE storage_hash = 'hash-idempotent'
        `;
        expect(count).toBe(1);
    });
});

describe('E2E: Build verification', () => {
    it('esbuild bundle exists and is under 1MB', () => {
        const bundlePath = path.join(__dirname, '..', '..', 'dist', 'extension.js');
        expect(fs.existsSync(bundlePath)).toBe(true);

        const stat = fs.statSync(bundlePath);
        expect(stat.size).toBeLessThan(1_000_000); // under 1MB
        expect(stat.size).toBeGreaterThan(10_000);  // sanity: at least 10KB
    });
});
