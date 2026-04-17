# Snich — Production Architecture & Deep Analysis

## 1. Problem Statement

VS Code Copilot Chat stores conversations in volatile, hidden `workspaceStorage` folders as `.jsonl` files. These files:
- Can be silently deleted, overwritten, or rotated by VS Code
- Use an incremental patch format (not plain JSON) that's non-trivial to replay
- Support **chat forking** (branching from earlier messages), creating tree-structured conversations
- Support **checkpoint restore** — rolling back to previous states, which destroys data
- Are scattered across hundreds of workspace hash folders with no central index

**Snich** solves this by providing **real-time, lossless capture** of every mutation into a local PostgreSQL database, with soft-delete semantics guaranteeing zero data loss.

---

## 2. VS Code Chat Storage — Deep Technical Analysis

### 2.1 Storage Locations (Cross-Platform)

| Platform | Base Path |
|----------|-----------|
| Windows  | `%APPDATA%\Code\User\workspaceStorage\` |
| macOS    | `~/Library/Application Support/Code/User/workspaceStorage/` |
| Linux    | `~/.config/Code/User/workspaceStorage/` |

Each workspace gets a **hash folder** (e.g., `5e4f5a81d584b0f638a96f4e88534809`). Inside each hash folder:
- `workspace.json` — maps the hash to the actual workspace URI
- `chatSessions/` — contains `.jsonl` files (one per chat session)

### 2.2 JSONL Patch Format

Each `.jsonl` file is an **append-only event log** of incremental patches:

| Kind | Purpose | Example `k` (key path) | `v` (value) |
|------|---------|------------------------|-------------|
| `0`  | **Full initial state snapshot** | `[]` | `{ sessionId, creationDate, requests: [...] }` |
| `1`  | **Set a field** at a nested path | `["customTitle"]` | `"My chat about React"` |
| `2`  | **Array extend/splice** at path | `["requests"]` | `[{ message: {...}, response: [...] }]` |
| `2`  | **Streamed AI response chunk** | `["requests", 0, "response"]` | `[{ value: "partial text..." }]` |

### 2.3 Chat Forking Model

When a user **forks** a chat (edits a previous message or branches from an earlier turn):
- VS Code may create a **new `.jsonl` file** for the fork, OR
- Append `kind=2` operations that **replace entries at specific indices**
- The `kind=2` with key path `["requests", N, ...]` where N < current length = **mutation of existing turn** (potential fork signal)
- Some forks share the same `sessionId` prefix with a different suffix

**Critical insight**: The JSONL file is an event log, NOT a snapshot. To detect forks, we must track the **full sequence of operations** and detect when a previously-set index gets overwritten.

### 2.4 Checkpoint / Restore Behavior

- VS Code can restore previous conversation states
- This may **truncate** the JSONL file or append operations that revert array lengths
- Files can be **deleted entirely** when sessions are cleared
- VS Code Insiders and Stable may have different storage behavior

### 2.5 Multi-Window Considerations

- Each VS Code window is a separate Electron process
- Each window's extension host runs independently
- Multiple windows CAN open the same workspace (same hash folder)
- Multiple windows watching the global/empty-window sessions will see the same files
- File system events fire for ALL watchers — no deduplication at OS level

---

## 3. Architecture

### 3.1 High-Level Component Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                    VS Code Window 1                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ FileWatcher  │→│ JSONL Replayer│→│ EventProcessor       │ │
│  │ (chokidar)   │  │ (stateful)   │  │ (dedup + normalize)  │ │
│  └─────────────┘  └──────────────┘  └──────────┬───────────┘ │
│  ┌─────────────┐  ┌──────────────┐             │             │
│  │ SearchUI     │  │ ExportModule │             │             │
│  │ (webview)    │  │ (md/html/json│             │             │
│  └─────────────┘  └──────────────┘             │             │
│  ┌─────────────┐                               │             │
│  │ StatusBar    │                               │             │
│  │ Indicator    │                               │             │
│  └─────────────┘                               │             │
└────────────────────────────────────────────────│─────────────┘
                                                 │
┌───────────────────────────────────────────────────────────────┐
│                    VS Code Window 2                           │
│  (same components, different instance_id)      │             │
└────────────────────────────────────────────────│─────────────┘
                                                 │
                                    ┌────────────▼────────────┐
                                    │   PostgreSQL (local)     │
                                    │                          │
                                    │  ┌────────────────────┐  │
                                    │  │ raw_events (immut.) │  │
                                    │  │ sessions            │  │
                                    │  │ messages            │  │
                                    │  │ message_versions    │  │
                                    │  │ session_snapshots   │  │
                                    │  │ watch_state         │  │
                                    │  │ workspaces          │  │
                                    │  └────────────────────┘  │
                                    │                          │
                                    │  LISTEN/NOTIFY channels  │
                                    │  for webhook handover    │
                                    └──────────────────────────┘
                                                 │
                                    ┌────────────▼────────────┐
                                    │  Optional: Webhook       │
                                    │  Handover Service        │
                                    │  (REST/gRPC consumer)    │
                                    └──────────────────────────┘
```

### 3.2 Why NOT Git for Change Detection

| Criterion | Git-based | FileSystemWatcher |
|-----------|-----------|-------------------|
| Latency | Seconds (poll + diff) | Milliseconds (OS events) |
| CPU overhead | High (full diff on every poll) | Near zero (kernel events) |
| Deployment | Requires git init in VS Code internals | Zero setup |
| Granularity | File-level only | File-level (sufficient) |
| Multi-window | Race conditions on git operations | Each watcher independent |
| Risk | Modifying VS Code internal folders | Read-only |

**Decision**: Use `vscode.workspace.createFileSystemWatcher` for the current workspace's chat folder, plus a Node.js `chokidar` watcher for the global `workspaceStorage/` to catch all sessions across workspaces.

### 3.3 Why Direct PostgreSQL (No Sidecar)

- Sidecar = additional process to manage, monitor, restart → **enterprise friction**
- PostgreSQL natively handles concurrent connections from multiple VS Code windows
- Connection pooling via `pg-pool` keeps connections lightweight
- `INSERT ... ON CONFLICT DO NOTHING` provides idempotent deduplication
- LISTEN/NOTIFY provides the webhook handover without additional infrastructure
- **One fewer thing to install = easier adoption**

---

## 4. Database Schema

### 4.1 Core Tables

```sql
-- ============================================================
-- IMMUTABLE EVENT LOG — The single source of truth
-- Every JSONL line ever seen, never modified, never deleted
-- ============================================================
CREATE TABLE raw_events (
    id              BIGSERIAL PRIMARY KEY,
    event_hash      VARCHAR(64) UNIQUE NOT NULL,  -- SHA-256(file_path + line_num + content)
    workspace_id    INTEGER NOT NULL REFERENCES workspaces(id),
    session_file    VARCHAR(500) NOT NULL,         -- relative path within workspaceStorage
    line_number     INTEGER NOT NULL,
    kind            SMALLINT NOT NULL,             -- 0, 1, 2
    key_path        TEXT[] NOT NULL DEFAULT '{}',  -- the 'k' array from JSONL
    raw_content     JSONB NOT NULL,                -- the full JSONL line
    parsed_value    JSONB,                         -- the 'v' extracted
    file_mtime      TIMESTAMPTZ,
    file_size       BIGINT,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    instance_id     VARCHAR(64) NOT NULL           -- which VS Code window detected this
);
CREATE INDEX idx_raw_events_session ON raw_events(session_file);
CREATE INDEX idx_raw_events_workspace ON raw_events(workspace_id);
CREATE INDEX idx_raw_events_detected ON raw_events(detected_at);

-- ============================================================
-- WORKSPACES — One row per workspace hash
-- ============================================================
CREATE TABLE workspaces (
    id              SERIAL PRIMARY KEY,
    storage_hash    VARCHAR(64) UNIQUE NOT NULL,   -- the folder hash
    folder_uri      TEXT,                           -- from workspace.json
    display_name    VARCHAR(255),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                    -- soft delete
);
CREATE INDEX idx_workspaces_active ON workspaces(deleted_at) WHERE deleted_at IS NULL;

-- ============================================================
-- SESSIONS — Materialized view of chat sessions
-- ============================================================
CREATE TABLE sessions (
    id              SERIAL PRIMARY KEY,
    session_uuid    VARCHAR(255) UNIQUE NOT NULL,   -- Copilot's sessionId
    workspace_id    INTEGER NOT NULL REFERENCES workspaces(id),
    title           VARCHAR(500),
    custom_title    VARCHAR(500),
    model_info      VARCHAR(100),
    created_at      TIMESTAMPTZ,
    last_modified_at TIMESTAMPTZ,
    source_file     VARCHAR(500),                   -- original JSONL file path
    turn_count      INTEGER NOT NULL DEFAULT 0,
    fork_parent_id  INTEGER REFERENCES sessions(id), -- if this session was forked
    fork_point      INTEGER,                         -- request index where fork happened
    version         INTEGER NOT NULL DEFAULT 1,
    deleted_at      TIMESTAMPTZ,                     -- soft delete
    deletion_reason VARCHAR(100)                     -- 'user_cleared', 'vscode_gc', 'checkpoint_restore'
);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_active ON sessions(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_modified ON sessions(last_modified_at DESC);

-- ============================================================
-- MESSAGES — Full message tree with fork support
-- ============================================================
CREATE TABLE messages (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    request_index   INTEGER NOT NULL,               -- position in the requests array
    role            VARCHAR(20) NOT NULL,            -- 'user' | 'assistant'
    content         TEXT NOT NULL,
    content_hash    VARCHAR(64) NOT NULL,            -- for dedup & change detection
    parent_id       BIGINT REFERENCES messages(id),  -- tree structure for forks
    fork_source_id  BIGINT REFERENCES messages(id),  -- which message was replaced
    is_fork         BOOLEAN NOT NULL DEFAULT FALSE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,                     -- soft delete
    metadata        JSONB                            -- model, tool calls, references, etc.
);
CREATE INDEX idx_messages_session ON messages(session_id, request_index);
CREATE INDEX idx_messages_content ON messages USING gin(to_tsvector('english', content));
CREATE INDEX idx_messages_active ON messages(deleted_at) WHERE deleted_at IS NULL;

-- ============================================================
-- MESSAGE VERSIONS — Every mutation of every message
-- ============================================================
CREATE TABLE message_versions (
    id              BIGSERIAL PRIMARY KEY,
    message_id      BIGINT NOT NULL REFERENCES messages(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    content_hash    VARCHAR(64) NOT NULL,
    change_type     VARCHAR(50) NOT NULL,            -- 'created', 'streamed', 'edited', 'forked', 'restored'
    raw_event_id    BIGINT REFERENCES raw_events(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, version)
);
CREATE INDEX idx_msg_versions_message ON message_versions(message_id);

-- ============================================================
-- SESSION SNAPSHOTS — Periodic full-state captures
-- ============================================================
CREATE TABLE session_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    snapshot_hash   VARCHAR(64) NOT NULL,
    full_state      JSONB NOT NULL,                  -- replayed full session state
    message_count   INTEGER NOT NULL,
    trigger         VARCHAR(50) NOT NULL,            -- 'periodic', 'pre_delete', 'file_change', 'export'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_snapshots_session ON session_snapshots(session_id);

-- ============================================================
-- WATCH STATE — Resume tracking after extension restart
-- ============================================================
CREATE TABLE watch_state (
    id              SERIAL PRIMARY KEY,
    file_path       VARCHAR(500) UNIQUE NOT NULL,
    last_line_read  INTEGER NOT NULL DEFAULT 0,
    last_file_size  BIGINT NOT NULL DEFAULT 0,
    last_mtime      TIMESTAMPTZ,
    last_hash       VARCHAR(64),                     -- detect file replacement vs append
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EXTENSION INSTANCES — Track active windows
-- ============================================================
CREATE TABLE extension_instances (
    id              SERIAL PRIMARY KEY,
    instance_id     VARCHAR(64) UNIQUE NOT NULL,
    workspace_hash  VARCHAR(64),
    pid             INTEGER,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================
-- SCHEMA MIGRATIONS — Versioned schema management
-- ============================================================
CREATE TABLE schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.2 Soft Delete Contract

**RULE: No `DELETE` statements are ever executed against sessions, messages, or workspaces.**

| Scenario | Action |
|----------|--------|
| VS Code deletes a `.jsonl` file | Set `sessions.deleted_at`, `sessions.deletion_reason = 'vscode_gc'`. Capture a pre-deletion snapshot. |
| User clears chat history | Set `sessions.deleted_at`, `deletion_reason = 'user_cleared'`. |
| Checkpoint restore truncates messages | Mark affected messages' `deleted_at`. Create new message versions with `change_type = 'restored'`. |
| Workspace folder removed | Set `workspaces.deleted_at`. Sessions remain queryable. |
| File overwritten (size decreased) | Snapshot old state. Replay new file. Mark orphaned messages as `deleted_at`. |

### 4.3 Fork Detection Algorithm

```
WHEN processing kind=2 event with key_path ["requests", N, ...]:
  IF N < current_turn_count for this session:
    // This is a FORK — an existing turn is being modified
    1. Snapshot current session state
    2. Mark the old message at index N as deleted_at = NOW()
    3. Create a new message with:
       - fork_source_id = old_message.id
       - is_fork = TRUE
       - parent_id = message at index N-1 (or NULL if N=0)
    4. Mark all messages at indices > N as deleted_at (they belong to the old branch)
    5. Increment session.version
  ELSE:
    // Normal append — new turn
    Create message normally
```

---

## 5. Extension Components — Detailed Design

### 5.1 FileWatcher Module

```typescript
// Watches: <base>/workspaceStorage/*/chatSessions/*.jsonl
// Uses: vscode.workspace.createFileSystemWatcher for current workspace
// Uses: chokidar for global workspaceStorage (broader scope)

interface WatchEvent {
    type: 'created' | 'changed' | 'deleted';
    filePath: string;
    workspaceHash: string;
    sessionFile: string;
    timestamp: Date;
}
```

**Key behaviors:**
1. On extension activate: scan ALL existing `.jsonl` files, diff against `watch_state` to find unprocessed lines
2. On file `created`: full parse + ingest
3. On file `changed`: read only NEW lines (from `watch_state.last_line_read` offset)
4. On file `deleted`: soft-delete the session + capture snapshot from last known state
5. **Debounce**: 200ms debounce on change events (VS Code writes frequently during streaming)
6. **File identity**: Track `(inode, size, mtime)` — if size DECREASES, the file was replaced (checkpoint restore), not appended to

### 5.2 JSONL Replayer (Stateful Parser)

```typescript
interface SessionState {
    sessionId: string;
    creationDate: string;
    customTitle?: string;
    requests: RequestState[];
    version: number;
}

interface RequestState {
    index: number;
    userMessage: string;
    responses: ResponseChunk[];
    metadata: Record<string, unknown>;
}

class JsonlReplayer {
    private state: SessionState;

    // Apply a single JSONL line and return the delta
    apply(line: JsonlLine): StateDelta;

    // Detect if this operation constitutes a fork
    isFork(line: JsonlLine): boolean;

    // Get full materialized state
    getState(): SessionState;

    // Serialize for snapshot
    snapshot(): string;
}
```

### 5.3 EventProcessor (Deduplication + DB Writes)

```typescript
class EventProcessor {
    private pool: pg.Pool;
    private instanceId: string;  // UUID generated per activation

    // Core pipeline
    async processFileChange(event: WatchEvent): Promise<void> {
        // 1. Read new lines from file (from last known offset)
        // 2. For each line:
        //    a. Compute event_hash = SHA-256(filePath + lineNum + content)
        //    b. INSERT INTO raw_events ... ON CONFLICT (event_hash) DO NOTHING
        //    c. If inserted (not duplicate): apply to replayer, update materialized tables
        // 3. Update watch_state
    }

    // Idempotent: safe to call from multiple windows
    async ingestEvent(event: RawEvent): Promise<boolean> {
        return await this.pool.query(`
            INSERT INTO raw_events (event_hash, workspace_id, ...)
            VALUES ($1, $2, ...)
            ON CONFLICT (event_hash) DO NOTHING
            RETURNING id
        `);
        // Returns true if this instance was first to capture
    }
}
```

### 5.4 Multi-Window Coordination

```
Window 1 watches: workspace A + global sessions
Window 2 watches: workspace B + global sessions
Window 3 watches: workspace A + global sessions  ← OVERLAP

Deduplication strategy:
1. Each raw_event gets a deterministic hash: SHA-256(file_path + line_number + content)
2. INSERT ... ON CONFLICT DO NOTHING ensures only first writer wins
3. The "winning" window proceeds to update materialized tables
4. The "losing" window sees RETURNING id = null, skips materialization
5. Heartbeat table tracks which windows are alive (stale cleanup)
```

**Advisory locks** for session-level operations:
```sql
-- Before materializing a session's messages:
SELECT pg_advisory_xact_lock(hashtext(session_uuid));
-- This serializes concurrent updates to the same session across windows
```

### 5.5 Connection Management

```typescript
const pool = new Pool({
    host: config.host,          // default: 'localhost'
    port: config.port,          // default: 5432
    database: config.database,  // default: 'snich'
    user: config.user,
    password: config.password,
    max: 3,                     // per window — light footprint
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});
```

- 3 connections per window × 5 windows = 15 connections max (well within PostgreSQL defaults)
- Pool auto-reconnects on transient failures
- Events queued in memory during disconnection (bounded queue, persist to disk if > 1000)

### 5.6 Resilience: Local Queue for DB Outage

```typescript
class ResilientEventProcessor {
    private queue: RawEvent[] = [];
    private diskQueuePath: string;  // extension globalStorage
    private maxMemoryQueue = 1000;

    async process(event: RawEvent): Promise<void> {
        try {
            await this.ingestEvent(event);
            await this.drainQueue();  // process any backlog
        } catch (e) {
            if (isConnectionError(e)) {
                this.enqueue(event);   // in-memory, spill to disk
                this.scheduleRetry();
            } else {
                throw e;               // schema errors etc. → fail loud
            }
        }
    }
}
```

---

## 6. Search, Filter & Export

### 6.1 Full-Text Search

PostgreSQL's built-in `tsvector` + `GIN` index provides production-grade full-text search:

```sql
-- Search across all messages
SELECT s.title, m.role, m.content, ts_rank(to_tsvector('english', m.content), query) AS rank
FROM messages m
JOIN sessions s ON m.session_id = s.id
CROSS JOIN plainto_tsquery('english', $1) AS query
WHERE m.deleted_at IS NULL
  AND to_tsvector('english', m.content) @@ query
ORDER BY rank DESC
LIMIT 50;
```

### 6.2 Filter Capabilities

| Filter | SQL |
|--------|-----|
| By workspace | `WHERE s.workspace_id = $1` |
| By date range | `WHERE s.created_at BETWEEN $1 AND $2` |
| By model | `WHERE m.metadata->>'model' = $1` |
| Active only | `WHERE s.deleted_at IS NULL` |
| Include deleted | `WHERE TRUE` (omit the deleted_at filter) |
| Forks only | `WHERE m.is_fork = TRUE` |
| By session title | `WHERE s.title ILIKE '%' || $1 || '%'` |

### 6.3 Export Formats

```typescript
interface ExportOptions {
    format: 'markdown' | 'html' | 'json' | 'jsonl';
    sessions: string[];          // session UUIDs
    includeDeleted: boolean;
    includeForks: boolean;
    includeVersionHistory: boolean;
    includeMetadata: boolean;
    template?: string;           // custom Handlebars template
}
```

**Markdown export** (human-readable):
```markdown
---
title: "Debugging React Hooks"
workspace: "my-project"
date: 2026-04-15
model: gpt-4o
turns: 12
tags: [copilot, exported-by-snich]
---

# Debugging React Hooks

## Turn 1

**User** (2026-04-15 09:30:22)
How do I fix the stale closure in this useEffect?

**Copilot** (gpt-4o)
The issue is...

---

## Turn 2 *(forked from Turn 1)*

**User** (2026-04-15 09:35:10)
Actually, can you show me the useCallback approach instead?

...
```

---

## 7. Webhook / Handover Service

### 7.1 PostgreSQL LISTEN/NOTIFY

```sql
-- Trigger on new events
CREATE OR REPLACE FUNCTION notify_new_event() RETURNS trigger AS $$
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
    FOR EACH ROW EXECUTE FUNCTION notify_new_event();
```

### 7.2 Optional Webhook Forwarder

A separate lightweight process (or the extension itself) can:
```typescript
const client = new pg.Client(connectionString);
await client.connect();
await client.query('LISTEN snich_events');
client.on('notification', async (msg) => {
    const payload = JSON.parse(msg.payload);
    await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
});
```

This enables handover to:
- Elasticsearch for advanced search
- A team dashboard
- An LLM for meta-analysis
- A backup/sync service

---

## 8. Project Structure

```
snich/
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── src/
│   ├── extension.ts                 # activate/deactivate, command registration
│   ├── config.ts                    # Settings resolution
│   ├── watcher/
│   │   ├── fileWatcher.ts           # OS-level file monitoring
│   │   ├── storageLocator.ts        # Cross-platform path resolution
│   │   └── debouncer.ts             # Change event debouncing
│   ├── parser/
│   │   ├── jsonlReplayer.ts         # Stateful JSONL patch replayer
│   │   ├── jsonParser.ts            # Legacy .json parser
│   │   ├── forkDetector.ts          # Fork identification logic
│   │   └── types.ts                 # Shared parser types
│   ├── db/
│   │   ├── pool.ts                  # pg-pool management
│   │   ├── migrations/
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_indexes.sql
│   │   │   └── runner.ts            # Migration runner
│   │   ├── repositories/
│   │   │   ├── rawEventRepo.ts      # raw_events CRUD
│   │   │   ├── sessionRepo.ts       # sessions CRUD
│   │   │   ├── messageRepo.ts       # messages + versions
│   │   │   ├── workspaceRepo.ts     # workspaces
│   │   │   └── watchStateRepo.ts    # watch_state
│   │   └── types.ts
│   ├── processor/
│   │   ├── eventProcessor.ts        # Main pipeline orchestrator
│   │   ├── deduplicator.ts          # Hash-based dedup
│   │   ├── materializer.ts          # raw_events → sessions/messages
│   │   ├── snapshotManager.ts       # Periodic + on-demand snapshots
│   │   └── localQueue.ts            # Resilience queue for DB outage
│   ├── export/
│   │   ├── markdownExporter.ts
│   │   ├── htmlExporter.ts
│   │   ├── jsonExporter.ts
│   │   └── templateEngine.ts
│   ├── search/
│   │   └── searchEngine.ts          # Full-text search queries
│   ├── ui/
│   │   ├── statusBar.ts             # Connection status + stats
│   │   ├── searchWebview.ts         # Search & filter UI
│   │   ├── sessionTreeView.ts       # Sidebar tree of sessions
│   │   └── webview/
│   │       ├── search.html
│   │       ├── search.css
│   │       └── search.js
│   └── utils/
│       ├── hash.ts                  # SHA-256 utilities
│       ├── logger.ts                # Structured logging
│       └── platform.ts              # OS detection
├── migrations/
│   ├── 001_initial_schema.sql
│   └── 002_add_search_indexes.sql
├── test/
│   ├── unit/
│   │   ├── jsonlReplayer.test.ts
│   │   ├── forkDetector.test.ts
│   │   ├── deduplicator.test.ts
│   │   └── eventProcessor.test.ts
│   └── integration/
│       ├── dbIngestion.test.ts
│       └── multiWindow.test.ts
├── package.json
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
├── ARCHITECTURE.md
├── CHANGELOG.md
└── README.md
```

---

## 9. Configuration (VS Code Settings)

```jsonc
{
    // PostgreSQL connection
    "snich.database.host": "localhost",
    "snich.database.port": 5432,
    "snich.database.name": "snich",
    "snich.database.user": "snich",
    "snich.database.password": "",           // or use env var SNICH_DB_PASSWORD
    "snich.database.ssl": false,
    "snich.database.connectionString": "",    // overrides individual fields

    // Watcher behavior
    "snich.watcher.enabled": true,
    "snich.watcher.debounceMs": 200,
    "snich.watcher.watchAllWorkspaces": true, // false = current workspace only
    "snich.watcher.includeInsiders": true,    // also watch Code - Insiders

    // Snapshot policy
    "snich.snapshots.periodicIntervalMinutes": 30,
    "snich.snapshots.onEveryNthEvent": 50,

    // Export defaults
    "snich.export.defaultFormat": "markdown",
    "snich.export.includeMetadata": true,
    "snich.export.defaultFolder": "${workspaceFolder}/.snich-exports",

    // Webhook handover
    "snich.webhook.enabled": false,
    "snich.webhook.url": "",
    "snich.webhook.secret": "",
    "snich.webhook.events": ["session.created", "message.added", "session.deleted"],

    // Performance
    "snich.performance.maxMemoryQueueSize": 1000,
    "snich.performance.batchInsertSize": 100
}
```

---

## 10. Commands (Command Palette)

| Command | ID | Description |
|---------|----|-------------|
| Snich: Show Status | `snich.showStatus` | DB connection, events processed, queue depth |
| Snich: Search Chats | `snich.search` | Open search webview with full-text + filters |
| Snich: Export Session | `snich.exportSession` | Pick session → export to file |
| Snich: Export All | `snich.exportAll` | Bulk export with format picker |
| Snich: Force Sync | `snich.forceSync` | Full re-scan of all chat files |
| Snich: Show Session History | `snich.sessionHistory` | View all versions + forks of a session |
| Snich: Recover Deleted | `snich.recoverDeleted` | Browse + export soft-deleted sessions |
| Snich: Run Migrations | `snich.runMigrations` | Apply pending DB schema changes |
| Snich: Test Connection | `snich.testConnection` | Verify PostgreSQL connectivity |

---

## 11. Implementation Phases

### Phase 1 — Foundation (Week 1-2)
- [ ] Project scaffold (package.json, tsconfig, esbuild)
- [ ] StorageLocator (cross-platform path resolution)
- [ ] PostgreSQL connection + migration runner
- [ ] Initial schema (001_initial_schema.sql)
- [ ] Basic FileWatcher (current workspace only)
- [ ] JSONL Replayer (kind 0, 1, 2 basic support)
- [ ] raw_events ingestion with dedup
- [ ] watch_state tracking
- [ ] `snich.testConnection` command

### Phase 2 — Core Pipeline (Week 3-4)
- [ ] EventProcessor with materialization (sessions + messages)
- [ ] Fork detection logic
- [ ] Soft delete on file removal
- [ ] Session snapshot on delete
- [ ] Multi-workspace watching (chokidar)
- [ ] Instance heartbeat + dedup across windows
- [ ] StatusBar indicator (connected/disconnected/events count)
- [ ] `snich.forceSync` command
- [ ] Resilient local queue for DB outage

### Phase 3 — Search & Export (Week 5-6)
- [ ] Full-text search queries
- [ ] Search webview UI
- [ ] Session tree view in sidebar
- [ ] Markdown exporter
- [ ] HTML exporter
- [ ] JSON exporter
- [ ] `snich.search`, `snich.exportSession`, `snich.exportAll` commands

### Phase 4 — Enterprise Polish (Week 7-8)
- [ ] Webhook handover (LISTEN/NOTIFY + HTTP POST)
- [ ] Recover deleted sessions UI
- [ ] Session history / version diff view
- [ ] Connection string via environment variable
- [ ] SSL support for PostgreSQL
- [ ] Comprehensive error messages + troubleshooting guide
- [ ] Performance testing with 1000+ sessions
- [ ] Unit + integration test suite
- [ ] CI/CD pipeline
- [ ] VS Code Marketplace packaging

---

## 12. Critical Design Decisions & Rationale

### D1: Append-only raw_events table
**Why**: The JSONL files themselves are append-only event logs. We mirror this pattern in PostgreSQL. Even if VS Code deletes the file, we have the complete event history. This is the **audit trail** — the materialized `sessions` and `messages` tables are derived views.

### D2: SHA-256 event hashing for deduplication
**Why**: Multiple VS Code windows can detect the same file change. Rather than distributed locking, we use content-addressable storage. The hash makes every INSERT idempotent. PostgreSQL's `ON CONFLICT DO NOTHING` makes this O(1).

### D3: Advisory locks per session, not global locks
**Why**: Global locks would serialize all processing. Advisory locks scoped to `session_uuid` allow parallel processing of different sessions while preventing race conditions on the same session from multiple windows.

### D4: Snapshots as insurance
**Why**: If the JSONL replayer has a bug, or if VS Code changes the format, we can reconstruct from snapshots. Snapshots are cheap (one JSONB column) and invaluable for disaster recovery.

### D5: No ORM — raw SQL with parameterized queries
**Why**: The schema is stable and the queries are performance-critical. ORMs add overhead, hide query plans, and complicate advisory locks. Parameterized queries prevent SQL injection.

### D6: chokidar for global watching, vscode.workspace.createFileSystemWatcher for current
**Why**: VS Code's built-in watcher is limited to workspace-relative patterns. To watch ALL workspaceStorage folders (for the "all workspaces" view), we need chokidar watching the parent directory. The VS Code watcher is more efficient for the current workspace.

### D7: Debounce at 200ms
**Why**: During AI streaming, VS Code appends to the JSONL file every ~50ms. Without debounce, we'd process partial chunks unnecessarily. 200ms batches streaming chunks while keeping latency acceptable.

---

## 13. Security Considerations

| Concern | Mitigation |
|---------|------------|
| PostgreSQL credentials in settings | Support `SNICH_DB_PASSWORD` env var; never log credentials; use VS Code SecretStorage API |
| SQL injection | All queries use parameterized `$1, $2` — never string interpolation |
| File path traversal | Validate all paths are within `workspaceStorage`; reject symlinks outside |
| Webhook secret leakage | HMAC-sign webhook payloads; secret stored in SecretStorage |
| Chat content sensitivity | All data stays local; no telemetry; no network except configured webhook |
| Multi-user on shared machine | PostgreSQL user isolation; each user gets their own database |

---

## 14. Testing Strategy

### Unit Tests
- `jsonlReplayer.test.ts`: Feed known JSONL sequences, assert final state
- `forkDetector.test.ts`: Simulate fork scenarios, verify detection
- `deduplicator.test.ts`: Same event twice → only one insert
- `materializer.test.ts`: raw_events → correct sessions/messages

### Integration Tests
- Spin up a PostgreSQL container (testcontainers or Docker Compose)
- Write JSONL files to temp directory
- Verify end-to-end: file write → watcher event → DB insert → query result
- Simulate multi-window: two processors ingesting same file → no duplicates

### Stress Tests
- 1000 sessions × 50 turns = 50,000 messages
- Concurrent file writes from 5 simulated windows
- Verify no data loss, no deadlocks, query latency < 100ms

---

## 15. Deployment Guide (Enterprise)

### Option A: Docker Compose (Recommended)
```yaml
# docker-compose.yml — user runs this once
version: '3.8'
services:
  snich-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: snich
      POSTGRES_USER: snich
      POSTGRES_PASSWORD: ${SNICH_DB_PASSWORD:-snich_local}
    ports:
      - "5432:5432"
    volumes:
      - snich_data:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  snich_data:
```

### Option B: Existing PostgreSQL
```
1. CREATE DATABASE snich;
2. CREATE USER snich WITH PASSWORD '...';
3. GRANT ALL ON DATABASE snich TO snich;
4. Configure VS Code settings with connection details
5. Run "Snich: Run Migrations" from command palette
```

### Option C: Managed PostgreSQL (Supabase, Neon, RDS)
- Set connection string in settings
- Enable SSL: `"snich.database.ssl": true`
- Works identically — Snich doesn't use PostgreSQL-specific extensions
