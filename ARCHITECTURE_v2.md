# Snich — Production Architecture v2 (Post 10-Loop Refinement)

> **This document supersedes ARCHITECTURE.md**. Every section has been refined through 10 iterative research-and-critique loops incorporating real user pain points from GitHub issues, VS Code 1.116 changes (Copilot now built-in), JSONL format deep dive from recovery tools, file watcher OS-level behavior, PostgreSQL driver analysis, multi-window race conditions, enterprise compliance, and production extension patterns.

---

## 1. What Changed Since v1

| Area | v1 (Old) | v2 (Corrected) | Why |
|------|----------|----------------|-----|
| **File watcher** | `vscode.workspace.createFileSystemWatcher` + chokidar | **Node.js `fs.watch` directly** | VS Code's API filters to workspace-relative paths only; `%APPDATA%` paths are invisible to it. chokidar is no longer used by VS Code itself (deprecated in 1.63). |
| **PG driver** | `pg` (node-postgres) | **`postgres` (porsager)** | Pure JS, zero native modules, tagged template SQL (injection-proof by design), auto-pooling, smaller bundle, esbuild-compatible. |
| **JSONL `kind=2` model** | "Array extend only" | **Two modes: extend (`v` field) OR delete (`i` field)** | Fork = delete indices after fork point + extend with new branch. This is how VS Code implements chat forking. |
| **Copilot storage path** | `GitHub.copilot-chat` subfolder | **Built-in extension (1.116+)** — may be under `ms-vscode.copilot-chat` or core storage | Copilot Chat is now built-in as of April 2026. Storage folder name changes. Must auto-discover. |
| **Schema** | `event_hash VARCHAR(64)` | **`event_hash BYTEA`** (32 bytes, 50% smaller index) | SHA-256 is binary; storing as hex doubles size. BYTEA is faster for comparisons. |
| **Multi-window** | "Advisory locks per session" | **Advisory locks + transactional materialization with skip-if-duplicate** | Race between INSERT returning "first" vs. materialization needs transaction-scoped locks. |
| **Credential storage** | Settings JSON | **`SecretStorage` API + env var fallback** | VS Code SecretStorage uses OS keychain (Windows Credential Manager). Never plaintext in settings. |
| **Extension kind** | Unspecified | **`"extensionKind": ["workspace"]`** | Required for Remote SSH/WSL/Container support — extension must run where the files are. |
| **Activation** | `onStartupFinished` | **`onStartupFinished` + lazy init via `setTimeout(0)`** | Don't block startup. Initialize DB pool and watchers after event loop yields. |

---

## 2. VS Code Chat Storage — Corrected Technical Model

### 2.1 Storage Discovery (Multi-Variant)

Snich must discover chat files from **all** VS Code variants:

```
Base paths (per platform):
├── Code/User/workspaceStorage/          # VS Code Stable
├── Code - Insiders/User/workspaceStorage/  # Insiders
├── Code - Exploration/User/workspaceStorage/  # Exploration
└── VSCodium/User/workspaceStorage/      # VSCodium

Within each:
└── <hash>/
    ├── workspace.json            # {"folder":"file:///path/to/workspace"}
    └── state.vscdb               # SQLite DB (since ~1.64) — stores chat in some versions
    └── <extension-id>/           # Extension-specific subfolder (legacy)
        └── chatSessions/
            ├── <uuid>.jsonl      # One per chat session
            └── <uuid>.json       # Legacy format (pre-JSONL)
```

**Critical**: Since Copilot Chat is now built-in (1.116+), the chat data may be stored directly under the workspace hash folder's `state.vscdb` SQLite database OR in the legacy `chatSessions/` subfolder. Snich must check both locations.

**Auto-discovery algorithm:**
```
1. Enumerate all base paths (Stable, Insiders, etc.)
2. For each <hash> folder:
   a. Read workspace.json → extract workspace URI
   b. Check for chatSessions/ subfolder (legacy path)
   c. Check for state.vscdb SQLite (newer path)
   d. Register watchers for all discovered chat locations
3. Periodically re-scan (every 60s) for new workspace hashes
```

### 2.2 JSONL Patch Format — Complete Model

```typescript
interface JsonlPatch {
    kind: 0 | 1 | 2;
    k?: string[];     // key path (absent for kind=0)
    v?: unknown;      // value to set/extend
    i?: number;        // index to delete (kind=2 only, mutually exclusive with v)
}
```

| Kind | `k` | `v` | `i` | Operation |
|------|-----|-----|-----|-----------|
| `0` | absent | full state object | absent | **Replace entire state** |
| `1` | key path | value | absent | **Set value at nested path** |
| `2` | key path | array of items | absent | **Extend array at path** |
| `2` | key path | absent | integer index | **Delete element at index** |

**Replay algorithm:**
```typescript
function applyPatch(state: any, patch: JsonlPatch): any {
    if (patch.kind === 0) return patch.v;

    const path = patch.k!;
    const parent = navigateTo(state, path.slice(0, -1));
    const lastKey = path[path.length - 1];

    if (patch.kind === 1) {
        // Set nested value
        parent[lastKey] = patch.v;
    } else if (patch.kind === 2) {
        const target = parent[lastKey];
        if (patch.v !== undefined) {
            // Extend array
            target.push(...(patch.v as any[]));
        } else if (patch.i !== undefined) {
            // Delete at index
            target.splice(patch.i, 1);
        }
    }
    return state;
}
```

### 2.3 Fork Detection — Corrected Model

A fork in VS Code chat works as follows:

1. User clicks on a previous message → edits it
2. VS Code appends a sequence of `kind=2` patches:
   - **Delete** (`i` field): Remove requests at indices > fork_point (one per index, from highest to lowest)
   - **Extend** (`v` field): Append the new forked request(s)
3. Optionally, a `kind=1` patch updates the `customTitle`

**Detection in Snich:**
```
ON kind=2 with 'i' field:
    → This is a DELETE operation — a fork or checkpoint restore is happening
    → Snapshot the current state BEFORE applying the delete
    → Mark the deleted message as soft-deleted with reason 'forked' or 'checkpoint_restore'
    → Track which messages are affected

ON kind=2 with 'v' field at ["requests"] where turn_count decreased since last known state:
    → The array was truncated (deletes happened) and now new turns are appended
    → These new turns are the FORK BRANCH
    → Create messages with is_fork=TRUE, link to fork_source
```

### 2.4 Checkpoint / Restore — Corrected Model

When a user restores a checkpoint:
- VS Code may **rewrite the entire JSONL file** (file size decreases)
- Or append `kind=2` delete operations to remove turns after the checkpoint

**Detection:**
```
ON file change event where new_file_size < last_known_file_size:
    → File was REWRITTEN, not appended
    → Snapshot the old state
    → Re-read entire file from line 0
    → Diff against old state to detect what was removed
    → Soft-delete removed messages with reason 'checkpoint_restore'
    → Update watch_state to new file position
```

---

## 3. File Watching — Production Design

### 3.1 Why NOT `vscode.workspace.createFileSystemWatcher`

The VS Code API watcher **only works on workspace-relative paths**. Chat storage lives in `%APPDATA%` which is completely outside any workspace. The API will silently return zero events.

### 3.2 Actual Implementation: `fs.watch`

```typescript
class ChatFileWatcher {
    private watchers = new Map<string, fs.FSWatcher>();
    private debounceTimers = new Map<string, NodeJS.Timeout>();

    watchDirectory(chatSessionsDir: string): void {
        const watcher = fs.watch(chatSessionsDir, { persistent: false }, (eventType, filename) => {
            if (!filename?.endsWith('.jsonl')) return;
            this.debounce(path.join(chatSessionsDir, filename), 300);
        });

        // Handle watcher errors (directory deleted, permissions, etc.)
        watcher.on('error', (err) => {
            this.log.warn(`Watcher error on ${chatSessionsDir}: ${err.message}`);
            this.scheduleRescan(chatSessionsDir, 5000);
        });

        this.watchers.set(chatSessionsDir, watcher);
    }

    private debounce(filePath: string, ms: number): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(filePath, setTimeout(() => {
            this.debounceTimers.delete(filePath);
            this.onFileChanged(filePath);
        }, ms));
    }
}
```

### 3.3 OS-Level Behavior

| Platform | Backend | Rapid writes | File rewrite |
|----------|---------|-------------|--------------|
| Windows | `ReadDirectoryChangesW` | Coalesced into single event | Detected (size change) |
| macOS | `FSEvents` | Coalesced | Detected |
| Linux | `inotify` | Individual events | Detected |

**Key insight**: The OS may coalesce rapid write events. This is **fine** for Snich because we always re-read the file from the last known offset on any change event. We don't need per-write granularity.

### 3.4 Periodic Re-Scan (Belt and Suspenders)

File system events are **not guaranteed** by any OS. Snich runs a periodic scan:

```typescript
// Every 30 seconds: re-scan all known chat directories
setInterval(() => this.fullScan(), 30_000);

// Every 60 seconds: discover new workspace hashes
setInterval(() => this.discoverNewWorkspaces(), 60_000);
```

This catches:
- Dropped OS events
- Files created while the extension was starting up
- New workspaces opened in other windows
- Files modified on network drives (where events are unreliable)

### 3.5 File Read Strategy — Append-Only Optimization

```typescript
async processFileChange(filePath: string): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    const watchState = await this.db.getWatchState(filePath);

    if (!watchState) {
        // New file — read entirely
        await this.readFile(filePath, 0, stat.size);
        await this.db.setWatchState(filePath, stat.size, stat.mtimeMs, await this.fileHeaderHash(filePath));
        return;
    }

    if (stat.size < watchState.lastFileSize) {
        // FILE WAS REWRITTEN — checkpoint restore or VS Code internal rewrite
        // Snapshot old state, then re-read from beginning
        await this.snapshotSession(filePath);
        await this.readFile(filePath, 0, stat.size);
        await this.db.setWatchState(filePath, stat.size, stat.mtimeMs, await this.fileHeaderHash(filePath));
        return;
    }

    const headerHash = await this.fileHeaderHash(filePath);
    if (headerHash !== watchState.lastHeaderHash) {
        // First line changed — file was replaced entirely (not appended)
        await this.snapshotSession(filePath);
        await this.readFile(filePath, 0, stat.size);
        await this.db.setWatchState(filePath, stat.size, stat.mtimeMs, headerHash);
        return;
    }

    if (stat.size > watchState.lastFileSize) {
        // APPEND — read only new bytes
        await this.readFile(filePath, watchState.lastFileSize, stat.size);
        await this.db.setWatchState(filePath, stat.size, stat.mtimeMs, headerHash);
    }
    // else: no change (mtime changed but size didn't — touch or metadata update)
}
```

---

## 4. Database — Refined Schema

### 4.1 PostgreSQL Driver: `postgres` (porsager)

```typescript
import postgres from 'postgres';

const sql = postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    max: 3,                        // per VS Code window
    idle_timeout: 30,              // seconds
    connect_timeout: 5,            // seconds
    max_lifetime: 60 * 30,         // 30 minutes
    transform: { undefined: null },
    onnotice: () => {},            // suppress NOTICE messages
});
```

**Why `postgres` over `pg`:**
- Tagged template literals = SQL injection impossible by design: `sql\`SELECT * FROM sessions WHERE id = ${id}\``
- Automatic connection pooling (no manual Pool management)
- Pure JS, zero native modules, esbuild-friendly
- Smaller bundle (~50KB vs ~200KB)
- Built-in TypeScript types

### 4.2 Refined Schema

```sql
-- ============================================================
-- SCHEMA MIGRATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    checksum    VARCHAR(64) NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WORKSPACES
-- ============================================================
CREATE TABLE workspaces (
    id              SERIAL PRIMARY KEY,
    storage_hash    VARCHAR(64) UNIQUE NOT NULL,
    variant         VARCHAR(30) NOT NULL DEFAULT 'stable',  -- 'stable','insiders','exploration','vscodium'
    folder_uri      TEXT,
    display_name    VARCHAR(255),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

-- ============================================================
-- RAW EVENTS — Immutable append-only event log
-- ============================================================
CREATE TABLE raw_events (
    id              BIGSERIAL PRIMARY KEY,
    event_hash      BYTEA UNIQUE NOT NULL,              -- SHA-256 (32 bytes, binary)
    workspace_id    INTEGER NOT NULL REFERENCES workspaces(id),
    session_file    VARCHAR(500) NOT NULL,
    line_number     INTEGER NOT NULL,
    kind            SMALLINT NOT NULL,                   -- 0, 1, 2
    key_path        TEXT[] NOT NULL DEFAULT '{}',
    raw_content     JSONB NOT NULL,
    file_mtime      TIMESTAMPTZ,
    file_size       BIGINT,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    instance_id     UUID NOT NULL,
    batch_id        UUID                                 -- groups events from same file read
);

-- Partial index: only index non-duplicate events for faster lookup
CREATE INDEX idx_raw_events_session_file ON raw_events(session_file);
CREATE INDEX idx_raw_events_detected ON raw_events(detected_at);

-- ============================================================
-- SESSIONS
-- ============================================================
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
    fork_parent_id  INTEGER REFERENCES sessions(id),
    fork_point_idx  INTEGER,
    version         INTEGER NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,
    deletion_reason VARCHAR(50),                          -- 'user_cleared','vscode_gc','checkpoint_restore'
    last_event_id   BIGINT REFERENCES raw_events(id)     -- last processed event (cursor)
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_modified ON sessions(last_modified_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_title_search ON sessions USING gin(to_tsvector('simple', coalesce(custom_title, title, '')));

-- ============================================================
-- MESSAGES — Full message tree with fork support
-- ============================================================
CREATE TABLE messages (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    request_index   INTEGER NOT NULL,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         TEXT NOT NULL,
    content_hash    BYTEA NOT NULL,                      -- SHA-256 of content (32 bytes)
    parent_msg_id   BIGINT REFERENCES messages(id),
    fork_source_id  BIGINT REFERENCES messages(id),
    is_fork         BOOLEAN NOT NULL DEFAULT FALSE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    deletion_reason VARCHAR(50),
    metadata        JSONB,                               -- model, tool calls, references, token count
    UNIQUE(session_id, request_index, version)
);

CREATE INDEX idx_messages_session ON messages(session_id, request_index) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_fts ON messages USING gin(to_tsvector('english', content)) WHERE deleted_at IS NULL;

-- ============================================================
-- MESSAGE VERSIONS — Every mutation of every message
-- ============================================================
CREATE TABLE message_versions (
    id              BIGSERIAL PRIMARY KEY,
    message_id      BIGINT NOT NULL REFERENCES messages(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    content_hash    BYTEA NOT NULL,
    change_type     VARCHAR(30) NOT NULL CHECK (change_type IN
        ('created','streamed','edited','forked','restored','deleted')),
    raw_event_id    BIGINT REFERENCES raw_events(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, version)
);

-- ============================================================
-- SESSION SNAPSHOTS — Full-state captures for disaster recovery
-- ============================================================
CREATE TABLE session_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    snapshot_hash   BYTEA NOT NULL,                      -- SHA-256 of full_state
    full_state      JSONB NOT NULL,
    message_count   INTEGER NOT NULL,
    trigger         VARCHAR(30) NOT NULL CHECK (trigger IN
        ('periodic','pre_delete','file_rewrite','export','manual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_snapshots_session ON session_snapshots(session_id);

-- ============================================================
-- WATCH STATE — Resume tracking after restart
-- ============================================================
CREATE TABLE watch_state (
    id              SERIAL PRIMARY KEY,
    file_path       VARCHAR(500) UNIQUE NOT NULL,
    workspace_id    INTEGER REFERENCES workspaces(id),
    last_byte_offset BIGINT NOT NULL DEFAULT 0,          -- byte position, not line number
    last_file_size  BIGINT NOT NULL DEFAULT 0,
    last_mtime_ms   DOUBLE PRECISION,                    -- fs.stat mtimeMs
    header_hash     BYTEA,                               -- SHA-256 of first line (detect full rewrite)
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EXTENSION INSTANCES — Active window tracking
-- ============================================================
CREATE TABLE extension_instances (
    instance_id     UUID PRIMARY KEY,
    workspace_hash  VARCHAR(64),
    machine_id      VARCHAR(64),                         -- from vscode.env.machineId
    pid             INTEGER,
    vscode_version  VARCHAR(30),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================
-- DATA RETENTION POLICY
-- ============================================================
CREATE TABLE retention_policies (
    id              SERIAL PRIMARY KEY,
    scope           VARCHAR(30) NOT NULL DEFAULT 'global', -- 'global', workspace_id, session_id
    max_age_days    INTEGER,                               -- NULL = keep forever
    max_events      INTEGER,                               -- NULL = no limit
    redact_content  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOTIFY TRIGGER — For webhook handover
-- ============================================================
CREATE OR REPLACE FUNCTION notify_snich_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('snich_events', json_build_object(
        'event_id', NEW.id,
        'session_file', NEW.session_file,
        'kind', NEW.kind,
        'detected_at', NEW.detected_at
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_raw_event_notify
    AFTER INSERT ON raw_events
    FOR EACH ROW EXECUTE FUNCTION notify_snich_event();
```

### 4.3 Key Schema Changes from v1

| Change | Rationale |
|--------|-----------|
| `event_hash BYTEA` instead of `VARCHAR(64)` | 32 bytes vs 64 bytes — 50% smaller index, faster comparisons |
| `last_byte_offset` instead of `last_line_read` | Byte offsets allow seeking directly with `fs.createReadStream({start})` — no scanning lines |
| `header_hash` in `watch_state` | Detects file replacement (checkpoint restore) even if file size is the same |
| `batch_id UUID` in `raw_events` | Groups events from a single file read operation — useful for rollback |
| `machine_id` in `extension_instances` | Distinguishes instances on different machines (Remote SSH) |
| `retention_policies` table | Enterprise requirement: auto-purge after N days for compliance |
| `role` includes `'tool'` | VS Code 1.116 agent mode uses tool call/result messages |
| `last_event_id` in `sessions` | Cursor for incremental materialization — skip already-processed events |
| CHECK constraints | Enforce valid enum values at the DB level |

---

## 5. Multi-Window Coordination — Production Model

### 5.1 The Problem

```
Window 1 (workspace A): watches /workspaceStorage/abc123/chatSessions/
Window 2 (workspace A): watches /workspaceStorage/abc123/chatSessions/  ← SAME files
Window 3 (workspace B): watches /workspaceStorage/def456/chatSessions/
```

Both Window 1 and Window 2 receive the same `fs.watch` events for the same files within milliseconds of each other.

### 5.2 Three-Layer Deduplication

**Layer 1: Raw event hash (INSERT ... ON CONFLICT DO NOTHING)**
```typescript
const result = await sql`
    INSERT INTO raw_events (event_hash, workspace_id, session_file, line_number, kind, key_path, raw_content, instance_id, batch_id)
    VALUES (${hash}, ${wsId}, ${file}, ${lineNum}, ${kind}, ${keyPath}, ${content}, ${instanceId}, ${batchId})
    ON CONFLICT (event_hash) DO NOTHING
    RETURNING id
`;
const wasInserted = result.length > 0;
```

If `wasInserted` is false, this event was already captured by another window. **Stop here.**

**Layer 2: Advisory lock per session (serialize materialization)**
```typescript
if (wasInserted) {
    await sql.begin(async (tx) => {
        // Lock this session — blocks other windows materializing the same session
        await tx`SELECT pg_advisory_xact_lock(hashtext(${sessionUuid}))`;

        // Now safe to update sessions/messages tables
        await this.materialize(tx, sessionUuid, rawEvent);
    });
}
```

**Layer 3: Session version counter (optimistic concurrency)**
```typescript
// Only update if our version matches — catches any remaining edge cases
const updated = await tx`
    UPDATE sessions
    SET turn_count = ${newCount}, version = version + 1, last_modified_at = NOW()
    WHERE session_uuid = ${uuid} AND version = ${expectedVersion}
    RETURNING id
`;
if (updated.length === 0) {
    // Another window already updated — re-read and retry
    throw new RetryableError('Session version conflict');
}
```

### 5.3 Instance Lifecycle

```typescript
// On activation
const instanceId = crypto.randomUUID();
await sql`
    INSERT INTO extension_instances (instance_id, workspace_hash, machine_id, pid, vscode_version)
    VALUES (${instanceId}, ${wsHash}, ${vscode.env.machineId}, ${process.pid}, ${vscode.version})
`;

// Heartbeat every 30s
setInterval(async () => {
    await sql`UPDATE extension_instances SET last_heartbeat = NOW() WHERE instance_id = ${instanceId}`;
}, 30_000);

// On deactivation
async deactivate(): Promise<void> {
    await this.flushPendingEvents();
    await sql`UPDATE extension_instances SET is_active = FALSE WHERE instance_id = ${instanceId}`;
    await sql.end();
}

// Stale detection (on any instance startup)
await sql`
    UPDATE extension_instances
    SET is_active = FALSE
    WHERE last_heartbeat < NOW() - INTERVAL '2 minutes'
`;
```

---

## 6. Extension Lifecycle — Production Patterns

### 6.1 Activation

```typescript
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const log = vscode.window.createOutputChannel('Snich', { log: true });

    // Don't block activation — lazy init after event loop yields
    setTimeout(async () => {
        try {
            await initializeSnich(context, log);
        } catch (err) {
            log.error('Snich initialization failed', err);
            statusBar.showError('Snich: DB connection failed');
            // Extension degrades gracefully — no crash
        }
    }, 0);
}

async function initializeSnich(context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
    // 1. Load config
    const config = loadConfig(context);

    // 2. Resolve password from SecretStorage or env var
    const password = process.env.SNICH_DATABASE_URL
        ? undefined  // URL includes password
        : await context.secrets.get('snich.dbPassword')
          || process.env.SNICH_DB_PASSWORD
          || '';

    // 3. Connect to PostgreSQL
    const sql = createPool(config, password);
    await sql`SELECT 1`;  // connection test

    // 4. Run migrations
    await runMigrations(sql, log);

    // 5. Register instance
    const instanceId = crypto.randomUUID();
    await registerInstance(sql, instanceId, context);

    // 6. Discover chat storage directories
    const storageLocator = new StorageLocator(log);
    const chatDirs = await storageLocator.discover();

    // 7. Full initial scan (catch up on missed events)
    const processor = new EventProcessor(sql, instanceId, log);
    await processor.fullScan(chatDirs);

    // 8. Start watchers
    const watcher = new ChatFileWatcher(processor, log);
    chatDirs.forEach(dir => watcher.watchDirectory(dir));

    // 9. Start periodic re-scans
    const scanInterval = setInterval(() => processor.periodicScan(chatDirs), 30_000);
    const discoverInterval = setInterval(async () => {
        const newDirs = await storageLocator.discover();
        newDirs.filter(d => !chatDirs.includes(d)).forEach(d => {
            chatDirs.push(d);
            watcher.watchDirectory(d);
        });
    }, 60_000);

    // 10. Register commands
    registerCommands(context, sql, processor, log);

    // 11. Status bar
    const statusBar = new StatusBarManager(sql, log);
    statusBar.show();

    // 12. Cleanup on deactivation
    context.subscriptions.push({
        dispose: async () => {
            clearInterval(scanInterval);
            clearInterval(discoverInterval);
            watcher.dispose();
            await processor.flush();
            await deregisterInstance(sql, instanceId);
            await sql.end({ timeout: 5 });
        }
    });
}
```

### 6.2 Error Handling — Never Crash the Extension Host

```typescript
// EVERY async entry point wrapped in try/catch
function safeAsync(fn: (...args: any[]) => Promise<void>, log: vscode.LogOutputChannel) {
    return async (...args: any[]) => {
        try {
            await fn(...args);
        } catch (err) {
            log.error('Unhandled error in Snich', err);
            // Don't rethrow — an uncaught async error kills ALL extensions in this window
        }
    };
}

// Usage
watcher.on('change', safeAsync(async (filePath) => {
    await processor.processFileChange(filePath);
}, log));
```

### 6.3 Graceful Degradation

| Failure | Behavior |
|---------|----------|
| PostgreSQL unreachable on startup | Show warning, queue events in memory + disk, retry every 10s |
| PostgreSQL connection lost mid-operation | Queue events, auto-reconnect (built into `postgres` driver) |
| Chat directory not found | Log info, skip, re-check on next discovery cycle |
| Malformed JSONL line | Log warning, skip line, continue processing |
| JSONL file locked by another process | Retry after 500ms, max 3 retries |
| Extension host shutting down | Flush queue, close pool with 5s timeout |

### 6.4 Local Event Queue (DB Outage Resilience)

```typescript
class LocalEventQueue {
    private memoryQueue: RawEvent[] = [];
    private diskPath: string;
    private maxMemory = 5000;
    private isConnected = true;

    constructor(globalStoragePath: string) {
        this.diskPath = path.join(globalStoragePath, 'event-queue.jsonl');
    }

    enqueue(event: RawEvent): void {
        this.memoryQueue.push(event);
        if (this.memoryQueue.length > this.maxMemory) {
            this.spillToDisk();
        }
    }

    async drain(sql: postgres.Sql): Promise<number> {
        // Load from disk first (older events)
        const diskEvents = await this.loadFromDisk();
        const allEvents = [...diskEvents, ...this.memoryQueue];
        this.memoryQueue = [];

        let processed = 0;
        for (const event of allEvents) {
            try {
                await ingestRawEvent(sql, event);
                processed++;
            } catch (err) {
                // Re-queue failed events
                this.memoryQueue.push(event);
                break;
            }
        }
        if (this.memoryQueue.length === 0) await this.clearDisk();
        return processed;
    }
}
```

---

## 7. Scenarios Covered

### 7.1 Normal Chat Flow
```
User sends message → VS Code appends kind=2 to JSONL → fs.watch fires →
Snich reads new bytes → parses JSONL lines → inserts raw_events →
materializes to sessions/messages → done (< 50ms total)
```

### 7.2 AI Streaming Response
```
Copilot streams response → VS Code appends kind=2 chunks every ~50ms →
fs.watch coalesces into 1-3 events → Snich debounces 300ms →
reads all new bytes at once → batches into single raw_events insert →
updates message content with latest accumulated text
```

### 7.3 Chat Fork (User Edits Previous Message)
```
User edits turn 3 in a 5-turn chat:
VS Code appends: kind=2 delete i=4, kind=2 delete i=3, kind=2 extend new turn 3
Snich detects: kind=2 with 'i' field → FORK
→ Snapshot current state
→ Soft-delete messages at indices 3, 4 (deletion_reason='forked')
→ Create new message at index 3 with is_fork=TRUE, fork_source_id=old_msg_3
→ Increment session.version
```

### 7.4 Checkpoint Restore
```
User restores to turn 2 checkpoint:
VS Code rewrites JSONL file (file size decreases)
Snich detects: file_size < last_known_size → FILE REWRITE
→ Snapshot old state (trigger='file_rewrite')
→ Re-read entire file
→ Diff: messages 3, 4, 5 no longer exist
→ Soft-delete them (deletion_reason='checkpoint_restore')
→ Create message_versions with change_type='restored'
```

### 7.5 Session Deleted by VS Code
```
VS Code garbage-collects old session:
fs.watch fires 'rename' event (file deleted)
Snich detects: file gone
→ Snapshot session state (trigger='pre_delete')
→ Soft-delete session (deletion_reason='vscode_gc')
→ All messages remain queryable
→ User can recover via 'Snich: Recover Deleted' command
```

### 7.6 Multiple Windows, Same Workspace
```
Window 1 and Window 2 both detect JSONL change:
Window 1: INSERT raw_event hash=abc → success (RETURNING id = 42)
Window 2: INSERT raw_event hash=abc → conflict (RETURNING = empty)
Window 1: pg_advisory_lock(session) → materialize → release
Window 2: skips materialization (event was duplicate)
→ No double-counting, no race conditions
```

### 7.7 VS Code Update Changes Storage Format
```
Snich auto-discovery finds files in both old and new locations.
JSONL replay handles unknown 'kind' values gracefully (skip + log warning).
kind=0 snapshot always works as a reset point regardless of format changes.
```

### 7.8 PostgreSQL Down
```
Snich detects connection failure
→ Events queued in memory (up to 5000)
→ Overflow spills to disk (globalStoragePath/event-queue.jsonl)
→ StatusBar shows "Snich: DB offline (42 queued)"
→ Auto-reconnect every 10s (built into postgres driver)
→ On reconnect: drain queue, process all buffered events
→ No data lost
```

### 7.9 Remote SSH / WSL / Container
```
Extension runs on remote host (extensionKind: 'workspace')
→ workspaceStorage is on remote filesystem
→ fs.watch works on remote (native to that OS)
→ PostgreSQL must be reachable from remote host
→ Configure via SNICH_DATABASE_URL env var on remote
→ machine_id in extension_instances distinguishes local vs remote
```

### 7.10 VS Code Insiders + Stable Running Simultaneously
```
Snich in Stable watches: %APPDATA%/Code/User/workspaceStorage/
Snich in Insiders watches: %APPDATA%/Code - Insiders/User/workspaceStorage/
Both write to same PostgreSQL database
→ workspace.variant = 'stable' | 'insiders' distinguishes them
→ No conflicts (different storage_hash values)
→ User can search across both in one query
```

### 7.11 Large Session (50k+ Tokens, 200+ Turns)
```
File size: ~5MB of JSONL
Initial scan: read entire file → parse ~2000 lines → batch INSERT 2000 raw_events
Debounce handles streaming without overload
Full-text search index on messages covers content
Performance target: < 2s for initial scan of 5MB file
```

### 7.12 Content with Sensitive/Proprietary Code
```
Enterprise setting: snich.privacy.redactContent = true
→ All message content stored as "[REDACTED - hash: abc123]"
→ Metadata (timestamps, session structure, turn counts) preserved
→ Full-text search disabled when redaction is active
→ Original content never touches PostgreSQL
```

---

## 8. Project Structure — Final

```
snich/
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── src/
│   ├── extension.ts                 # activate/deactivate lifecycle
│   ├── config.ts                    # Settings + env var resolution
│   ├── types.ts                     # Shared types across modules
│   │
│   ├── discovery/
│   │   ├── storageLocator.ts        # Cross-platform path discovery
│   │   ├── variants.ts              # Stable/Insiders/VSCodium paths
│   │   └── workspaceResolver.ts     # workspace.json → folder URI
│   │
│   ├── watcher/
│   │   ├── chatFileWatcher.ts       # fs.watch wrapper with debounce
│   │   ├── fileReader.ts            # Byte-offset aware file reading
│   │   └── periodicScanner.ts       # Belt-and-suspenders re-scan
│   │
│   ├── parser/
│   │   ├── jsonlReplayer.ts         # Stateful kind=0/1/2 patch replayer
│   │   ├── forkDetector.ts          # Detects delete+extend fork pattern
│   │   ├── legacyJsonParser.ts      # .json format (pre-JSONL)
│   │   └── stateVscdbReader.ts      # state.vscdb SQLite reader (1.116+)
│   │
│   ├── db/
│   │   ├── connection.ts            # postgres pool setup + health check
│   │   ├── migrations.ts            # Migration runner
│   │   ├── migrate/
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_indexes.sql
│   │   │   └── 003_retention.sql
│   │   └── repos/
│   │       ├── rawEventRepo.ts
│   │       ├── sessionRepo.ts
│   │       ├── messageRepo.ts
│   │       ├── workspaceRepo.ts
│   │       ├── watchStateRepo.ts
│   │       └── snapshotRepo.ts
│   │
│   ├── processor/
│   │   ├── eventProcessor.ts        # Main pipeline: detect → parse → store
│   │   ├── materializer.ts          # raw_events → sessions/messages
│   │   ├── deduplicator.ts          # SHA-256 hash + ON CONFLICT
│   │   ├── snapshotManager.ts       # Periodic + event-triggered snapshots
│   │   └── localQueue.ts            # Memory + disk queue for DB outage
│   │
│   ├── export/
│   │   ├── markdownExporter.ts
│   │   ├── htmlExporter.ts
│   │   └── jsonExporter.ts
│   │
│   ├── search/
│   │   └── searchEngine.ts          # Full-text + filtered queries
│   │
│   ├── ui/
│   │   ├── statusBar.ts             # Connection status + event count
│   │   ├── sessionTreeView.ts       # Sidebar tree view
│   │   └── searchWebview/
│   │       ├── provider.ts
│   │       ├── search.html
│   │       └── search.css
│   │
│   └── utils/
│       ├── hash.ts                  # SHA-256 (crypto.createHash)
│       ├── logger.ts                # Structured logging wrapper
│       ├── platform.ts              # OS detection + path resolution
│       └── retry.ts                 # Exponential backoff helper
│
├── test/
│   ├── unit/
│   │   ├── jsonlReplayer.test.ts
│   │   ├── forkDetector.test.ts
│   │   ├── deduplicator.test.ts
│   │   ├── fileReader.test.ts
│   │   └── storageLocator.test.ts
│   ├── integration/
│   │   ├── pipeline.test.ts         # file → DB end-to-end
│   │   ├── multiWindow.test.ts
│   │   └── fixtures/
│   │       ├── simple-chat.jsonl
│   │       ├── forked-chat.jsonl
│   │       ├── streaming-chat.jsonl
│   │       └── checkpoint-restore.jsonl
│   └── setup.ts                     # Test PostgreSQL via testcontainers
│
├── package.json
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
├── ARCHITECTURE_v2.md
├── CHANGELOG.md
└── README.md
```

---

## 9. Configuration — Final

```jsonc
{
    // Connection (use SNICH_DATABASE_URL env var for containers)
    "snich.database.host": "localhost",
    "snich.database.port": 5432,
    "snich.database.name": "snich",
    "snich.database.user": "snich",
    "snich.database.ssl": false,
    // Password stored via SecretStorage ('Snich: Set Database Password' command)
    // Or SNICH_DB_PASSWORD env var

    // Watching
    "snich.watcher.enabled": true,
    "snich.watcher.debounceMs": 300,
    "snich.watcher.watchVariants": ["stable", "insiders"],
    "snich.watcher.periodicScanSeconds": 30,

    // Privacy / Enterprise
    "snich.privacy.redactContent": false,
    "snich.retention.maxAgeDays": null,        // null = keep forever
    "snich.retention.runCleanupOnStartup": false,

    // Export
    "snich.export.defaultFormat": "markdown",
    "snich.export.includeMetadata": true,
    "snich.export.includeForks": true,
    "snich.export.includeDeleted": false,

    // Webhook handover
    "snich.webhook.enabled": false,
    "snich.webhook.url": "",
    // Secret stored via SecretStorage ('Snich: Set Webhook Secret' command)

    // Performance
    "snich.performance.maxPoolConnections": 3,
    "snich.performance.maxMemoryQueueSize": 5000,
    "snich.performance.batchInsertSize": 200
}
```

---

## 10. Commands — Final

| Command | ID | Description |
|---------|----|-------------|
| Set Database Password | `snich.setDbPassword` | Store PG password in OS keychain via SecretStorage |
| Test Connection | `snich.testConnection` | Verify PostgreSQL connectivity + run migrations |
| Search Chats | `snich.search` | Open search webview with full-text + filters |
| Export Session | `snich.exportSession` | Pick session → export to file |
| Export All | `snich.exportAll` | Bulk export with format picker |
| Force Sync | `snich.forceSync` | Full re-scan of all chat files |
| Show Status | `snich.showStatus` | DB stats, queue depth, watcher count |
| Recover Deleted | `snich.recoverDeleted` | Browse + export soft-deleted sessions |
| Show Session History | `snich.sessionHistory` | All versions + forks of a session |
| Set Webhook Secret | `snich.setWebhookSecret` | Store webhook HMAC secret |
| Purge All Data | `snich.purgeAllData` | GDPR: hard-delete all data (confirmation required) |

---

## 11. Performance Targets

| Metric | Target | How |
|--------|--------|-----|
| Event detection latency | < 500ms | fs.watch + 300ms debounce |
| Raw event ingestion | < 5ms per event | Prepared statement + ON CONFLICT |
| Materialization | < 20ms per event | Advisory lock + single UPDATE |
| Initial scan (100 sessions) | < 5s | Parallel file reads + batch INSERT |
| Full-text search (50k messages) | < 200ms | GIN index on tsvector |
| Memory usage | < 50MB | Streaming file reads, bounded queue |
| Extension activation | < 100ms | Lazy init via setTimeout(0) |
| Extension bundle size | < 2MB | esbuild + tree shaking |
| DB connections per window | 3 | postgres auto-pool |

---

## 12. Security Model — Final

| Threat | Mitigation |
|--------|------------|
| DB password in settings.json | **Never.** SecretStorage API (OS keychain) or env var only |
| SQL injection | Tagged template literals (`postgres` driver) = structurally impossible |
| Path traversal | All paths validated against known base directories; symlinks not followed |
| Extension host crash | Every async entry point wrapped in try/catch; no unhandled rejections |
| Chat content exfiltration | All data local; no network except configured webhook; opt-in redaction |
| Webhook replay attacks | HMAC-SHA256 signature on payloads; timestamp validation |
| Multi-tenant on shared DB | Not supported — one DB per user/team. Use separate PG databases. |
| Stale connections | Pool `idle_timeout: 30s`, `max_lifetime: 30min` |
| Credential rotation | `Snich: Set Database Password` updates SecretStorage immediately |

---

## 13. Testing Strategy — Final

### Unit Tests (no DB required)
- `jsonlReplayer`: 15+ test cases covering all kind/path/edge combinations
- `forkDetector`: Fork, checkpoint restore, normal append, mixed sequences
- `deduplicator`: Same event twice, different events, hash collision resistance
- `fileReader`: Append mode, rewrite detection, header hash comparison
- `storageLocator`: Windows/macOS/Linux paths, Stable/Insiders/VSCodium

### Integration Tests (PostgreSQL via testcontainers)
- End-to-end pipeline: write JSONL file → verify DB state
- Multi-window simulation: two processors ingesting same file
- Fork scenario: verify soft-delete + fork message creation
- Checkpoint restore: verify rewrite detection + snapshot
- DB outage: verify queue + drain after reconnect
- Retention policy: verify auto-cleanup

### Performance Tests
- 1000 sessions × 50 turns = 50k messages: full scan < 30s
- 5 concurrent windows ingesting same session: no duplicates
- 100ms burst of 50 events: debounce reduces to 1 file read
- GIN index search across 50k messages: < 200ms

---

## 14. Deployment — Final

### Docker Compose (Recommended for first-time setup)
```yaml
version: '3.8'
services:
  snich-db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: snich
      POSTGRES_USER: snich
      POSTGRES_PASSWORD: ${SNICH_DB_PASSWORD:-snich_dev}
    ports:
      - "5432:5432"
    volumes:
      - snich_pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U snich"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  snich_pgdata:
```

### One-Liner Start
```bash
SNICH_DB_PASSWORD=your_secret docker compose up -d
```

Then in VS Code:
1. Install Snich extension
2. Run `Snich: Set Database Password` → enter `your_secret`
3. Run `Snich: Test Connection` → green checkmark
4. Done — real-time tracking starts automatically
