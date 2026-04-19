import * as crypto from 'crypto';
import postgres from 'postgres';

export interface Migration {
    version: number;
    name: string;
    sql: string;
    checksum: string;
}

function computeChecksum(sql: string): string {
    return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

const MIGRATION_001_SQL = `
-- WORKSPACES
CREATE TABLE workspaces (
    id              SERIAL PRIMARY KEY,
    storage_hash    VARCHAR(64) UNIQUE NOT NULL,
    variant         VARCHAR(30) NOT NULL DEFAULT 'stable',
    folder_uri      TEXT,
    display_name    VARCHAR(255),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

-- RAW EVENTS — Immutable append-only event log
CREATE TABLE raw_events (
    id              BIGSERIAL PRIMARY KEY,
    event_hash      BYTEA NOT NULL,
    workspace_id    INTEGER NOT NULL REFERENCES workspaces(id),
    session_file    VARCHAR(500) NOT NULL,
    byte_offset     BIGINT NOT NULL,
    kind            SMALLINT NOT NULL,
    key_path        TEXT[],
    raw_content     JSONB NOT NULL,
    file_mtime_ms   DOUBLE PRECISION,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    instance_id     UUID NOT NULL,
    batch_id        UUID,
    CONSTRAINT uq_raw_events_hash UNIQUE (event_hash)
);

CREATE INDEX idx_raw_events_session_file_id ON raw_events(session_file, id);
CREATE INDEX idx_raw_events_detected ON raw_events(detected_at);

-- SESSIONS
CREATE TABLE sessions (
    id              SERIAL PRIMARY KEY,
    session_uuid    VARCHAR(255) UNIQUE NOT NULL,
    workspace_id    INTEGER NOT NULL REFERENCES workspaces(id),
    title           VARCHAR(500),
    custom_title    VARCHAR(500),
    model_info      VARCHAR(100),
    created_at      TIMESTAMPTZ,
    last_modified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_file     VARCHAR(500),
    turn_count      INTEGER NOT NULL DEFAULT 0,
    fork_count      INTEGER NOT NULL DEFAULT 0,
    version         INTEGER NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,
    deletion_reason VARCHAR(50),
    last_event_id   BIGINT REFERENCES raw_events(id)
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_modified ON sessions(last_modified_at DESC) WHERE deleted_at IS NULL;

-- MESSAGES — Active conversation state
CREATE TABLE messages (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    request_index   INTEGER NOT NULL,
    role            VARCHAR(20) NOT NULL
        CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         TEXT NOT NULL DEFAULT '',
    content_hash    BYTEA,
    parent_msg_id   BIGINT REFERENCES messages(id),
    fork_source_id  BIGINT REFERENCES messages(id),
    is_fork         BOOLEAN NOT NULL DEFAULT FALSE,
    is_streaming    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at    TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    deletion_reason VARCHAR(50),
    metadata        JSONB
);

CREATE INDEX idx_messages_session ON messages(session_id, request_index)
    WHERE deleted_at IS NULL;

-- MESSAGE VERSIONS — Every mutation of every message
CREATE TABLE message_versions (
    id              BIGSERIAL PRIMARY KEY,
    message_id      BIGINT NOT NULL REFERENCES messages(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    content_hash    BYTEA NOT NULL,
    change_type     VARCHAR(30) NOT NULL
        CHECK (change_type IN ('created','streamed','finalized','edited','forked','restored','deleted')),
    raw_event_id    BIGINT REFERENCES raw_events(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, version)
);

-- SESSION SNAPSHOTS
CREATE TABLE session_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    snapshot_hash   BYTEA NOT NULL,
    full_state      JSONB NOT NULL,
    message_count   INTEGER NOT NULL,
    trigger         VARCHAR(30) NOT NULL
        CHECK (trigger IN ('periodic','pre_delete','pre_fork','file_rewrite','export','manual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_session ON session_snapshots(session_id);

-- WATCH STATE — Resume tracking after restart
CREATE TABLE watch_state (
    id              SERIAL PRIMARY KEY,
    file_path       VARCHAR(500) UNIQUE NOT NULL,
    workspace_id    INTEGER REFERENCES workspaces(id),
    last_byte_offset BIGINT NOT NULL DEFAULT 0,
    last_file_size  BIGINT NOT NULL DEFAULT 0,
    last_mtime_ms   DOUBLE PRECISION,
    header_hash     BYTEA,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- EXTENSION INSTANCES
CREATE TABLE extension_instances (
    instance_id     UUID PRIMARY KEY,
    workspace_hash  VARCHAR(64),
    machine_id      VARCHAR(64),
    pid             INTEGER,
    vscode_version  VARCHAR(30),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- AUTOVACUUM TUNING
ALTER TABLE messages SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05
);
`;

/**
 * Migration 002 — Full-fidelity turn capture.
 *
 * Adds `turns` and `turn_parts` tables so every response part (thinking,
 * tool calls, text, file edits, etc.) is stored verbatim as JSONB.
 * This allows complete reconstruction of the agent's conversation history.
 * The existing `messages` table is kept for backward compatibility as a
 * simplified summary view.
 */
const MIGRATION_002_SQL = `
-- TURNS — one row per user/AI request-response cycle
CREATE TABLE turns (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    turn_index      INTEGER NOT NULL,
    request_id      VARCHAR(200),
    response_id     VARCHAR(200),
    timestamp_ms    BIGINT,
    completed_at_ms BIGINT,
    model_id        VARCHAR(200),
    agent_id        VARCHAR(200),
    mode            VARCHAR(50),
    user_text       TEXT NOT NULL DEFAULT '',
    user_raw        JSONB,
    is_fork         BOOLEAN NOT NULL DEFAULT FALSE,
    fork_source_id  BIGINT REFERENCES turns(id),
    deleted_at      TIMESTAMPTZ,
    UNIQUE(session_id, turn_index)
);

CREATE INDEX idx_turns_session ON turns(session_id, turn_index) WHERE deleted_at IS NULL;

-- TURN_PARTS — every atomic piece of an AI response, in order
--   kind = NULL or '__text__' → plain AI text (value field)
--   kind = 'thinking'         → agent reasoning
--   kind = 'toolInvocationSerialized' → tool / sub-agent call
--   kind = 'textEditGroup'    → file edits applied
--   kind = 'inlineReference'  → code/symbol references
--   kind = 'codeblockUri'     → codeblock file link
--   kind = 'undoStop'         → undo checkpoint
--   kind = 'mcpServersStarting' → MCP lifecycle
CREATE TABLE turn_parts (
    id              BIGSERIAL PRIMARY KEY,
    turn_id         BIGINT NOT NULL REFERENCES turns(id),
    part_index      INTEGER NOT NULL,
    kind            VARCHAR(100),
    content         TEXT,
    raw_json        JSONB NOT NULL,
    UNIQUE(turn_id, part_index)
);

CREATE INDEX idx_turn_parts_turn ON turn_parts(turn_id, part_index);
CREATE INDEX idx_turn_parts_kind ON turn_parts(kind) WHERE kind IS NOT NULL;

ALTER TABLE turn_parts SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.05
);
`;

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: 'initial_schema',
        sql: MIGRATION_001_SQL,
        checksum: computeChecksum(MIGRATION_001_SQL),
    },
    {
        version: 2,
        name: 'full_fidelity_turns',
        sql: MIGRATION_002_SQL,
        checksum: computeChecksum(MIGRATION_002_SQL),
    },
];

/**
 * Run database migrations with advisory lock serialization.
 * Safe for concurrent execution from multiple VS Code windows.
 */
export async function runMigrations(
    sql: postgres.Sql,
    log: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): Promise<void> {
    // Session-level advisory lock — serializes across all windows
    await sql`SELECT pg_advisory_lock(4812375)`;

    try {
        // Ensure migration table exists
        await sql`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version     INTEGER PRIMARY KEY,
                name        VARCHAR(255) NOT NULL,
                checksum    VARCHAR(64) NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        const applied = await sql`SELECT version, checksum FROM schema_migrations ORDER BY version`;
        const appliedMap = new Map(applied.map(r => [r.version, r.checksum]));

        for (const migration of MIGRATIONS) {
            const existingChecksum = appliedMap.get(migration.version);

            if (existingChecksum) {
                // Verify checksum matches
                if (existingChecksum !== migration.checksum) {
                    throw new Error(
                        `Migration ${migration.version} (${migration.name}) checksum mismatch! ` +
                        `Expected ${migration.checksum}, got ${existingChecksum}. ` +
                        `Migration files must not be modified after deployment.`
                    );
                }
                continue;
            }

            log.info(`Applying migration ${migration.version}: ${migration.name}`);

            // Each migration runs in its own transaction (PostgreSQL DDL is transactional)
            await sql.begin(async (tx) => {
                await tx.unsafe(migration.sql);
                await tx`
                    INSERT INTO schema_migrations (version, name, checksum)
                    VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
                `;
            });

            log.info(`Migration ${migration.version} applied successfully`);
        }
    } finally {
        await sql`SELECT pg_advisory_unlock(4812375)`;
    }
}
