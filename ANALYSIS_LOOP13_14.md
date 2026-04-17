# Snich — Critical Analysis: Migration Safety & SQLite Reading

> Loops 13–14 deep analysis. Based on PostgreSQL documentation, SQLite documentation,
> VS Code source code inspection (`chatSessionStore.ts`), and live inspection of
> `state.vscdb` on the local machine.

---

## AREA 1: Migration Safety (Loop 13)

### Q1: Two Instances Run Migrations Simultaneously

**Scenario walkthrough:**

```
Instance 1: reads schema_migrations → empty → starts migration 001
Instance 2: reads schema_migrations → empty → starts migration 001
```

**What actually happens without protection:**

1. Both run `CREATE TABLE raw_events (...)`:
   - PostgreSQL DDL acquires an `AccessExclusiveLock` on the catalog. One succeeds, the other blocks until the first commits/rolls back.
   - If the first is inside a transaction and hasn't committed yet, the second **blocks** (it does NOT fail immediately — it waits).
   - Once the first commits, the second tries `CREATE TABLE raw_events` and gets: `ERROR: relation "raw_events" already exists`.
   - If using `CREATE TABLE IF NOT EXISTS`, the second succeeds (no-op).

2. Both INSERT into `schema_migrations`:
   - `version INTEGER PRIMARY KEY` → the second INSERT gets a unique constraint violation.
   - If inside a transaction, the entire transaction is aborted.

**Result without locking:** The second instance's migration transaction fails and rolls back cleanly. Data integrity is preserved, but the extension sees an error it must handle (retry or ignore).

**Verdict:** Without advisory locks, the system is **safe but noisy**. With advisory locks, it's **safe and clean**.

---

### Q2: Locking Strategy for Migrations

**Recommendation: Use `pg_advisory_lock` (session-level) with a single well-known lock ID.**

```sql
-- At the start of migration runner:
SELECT pg_advisory_lock(7629834);  -- arbitrary fixed constant

-- Run all pending migrations...

-- At the end:
SELECT pg_advisory_unlock(7629834);
```

**Why session-level (not transaction-level) advisory lock:**

Migration runners typically need to run each migration in its own transaction (especially for non-transactional DDL). A transaction-scoped `pg_advisory_xact_lock` would release the lock after each migration's transaction commits, allowing another instance to interleave. Session-level `pg_advisory_lock` holds across multiple transactions.

**Why NOT `pg_try_advisory_lock` (skip if locked):**

```sql
SELECT pg_try_advisory_lock(7629834);  -- returns false if already locked
```

Using `try` and skipping if locked is tempting but **wrong**. If Instance 2 skips migrations because Instance 1 is running them, Instance 2 might start querying tables that don't exist yet (Instance 1 is still mid-migration). Instead:

- **Block** (`pg_advisory_lock`) — Instance 2 waits until Instance 1 finishes, then checks `schema_migrations` and finds all migrations already applied. Zero wasted work, correct behavior.

**`CREATE TABLE IF NOT EXISTS` concurrent safety:**

In PostgreSQL, `CREATE TABLE IF NOT EXISTS` is safe under concurrent execution. The DDL acquires `AccessExclusiveLock` on the catalog, serializing concurrent attempts. The second caller either blocks until the first commits (then sees the table and does nothing) or, if both are in separate transactions, one gets an error that the transaction handles.

However, relying solely on `IF NOT EXISTS` is insufficient because:
- Not all DDL supports `IF NOT EXISTS` (e.g., `ALTER TABLE ADD COLUMN` does NOT in all cases)
- It doesn't help with `INSERT INTO schema_migrations` deduplication
- It gives no visibility into whether migration was already applied vs. being applied now

**Implementation pattern:**

```typescript
async function runMigrations(sql: postgres.Sql): Promise<void> {
  // Session-level lock — survives across transaction boundaries
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  
  try {
    // Ensure schema_migrations table exists
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        checksum    VARCHAR(64) NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    
    // Read applied versions
    const applied = await sql`SELECT version FROM schema_migrations ORDER BY version`;
    const appliedSet = new Set(applied.map(r => r.version));
    
    // Apply pending migrations
    for (const migration of ALL_MIGRATIONS) {
      if (appliedSet.has(migration.version)) continue;
      
      if (migration.transactional !== false) {
        // Normal migration — wrap in transaction
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx`
            INSERT INTO schema_migrations (version, name, checksum)
            VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
          `;
        });
      } else {
        // Non-transactional migration (see Q4)
        await sql.unsafe(migration.sql);
        await sql`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
        `;
      }
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }
}
```

---

### Q3: Failed Migration Mid-Way (Transactional)

**Scenario:** Migration 003 has 3 SQL statements. Statement 2 fails.

**If wrapped in a transaction:**
- The entire transaction rolls back. Table created by Statement 1 is rolled back (doesn't exist anymore).
- The `INSERT INTO schema_migrations` (which is inside the same transaction) is also rolled back.
- On retry: migration 003 runs from scratch on a clean slate. Statement 1 creates the table again. **This is correct and clean.**

**Key insight:** PostgreSQL DDL IS transactional (unlike MySQL, Oracle, SQL Server). `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` (non-concurrent), `DROP TABLE` — all participate in transactions and roll back cleanly. This is a major advantage of PostgreSQL.

**The only exception:** `CREATE INDEX CONCURRENTLY` (see Q4).

---

### Q4: Migration with Non-Transactional DDL

**`CREATE INDEX CONCURRENTLY` cannot run inside a transaction.** PostgreSQL will error:

```
ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

**What happens if it fails mid-way:**
- A partial/invalid index is left behind, marked as `INVALID` in `pg_index`.
- The index is not used by the query planner but consumes disk space.
- You can check for it: `SELECT * FROM pg_index WHERE indisvalid = false;`
- You must `DROP INDEX` the invalid index before retrying.

**How popular migration runners handle this:**

| Runner | Approach |
|--------|----------|
| **Flyway** | Supports `executeInTransaction=false` annotation per migration file. The migration runs outside a transaction. If it fails, the migration is marked as "failed" in the schema history table. Manual intervention required (repair command). |
| **Django** | Supports `atomic = False` on migration classes. Non-atomic migrations that fail leave partial state. Django marks the migration as not applied. Re-running requires manual cleanup. |
| **Knex** | No built-in support for non-transactional migrations. You'd have to use `knex.raw()` outside a transaction block. |
| **Prisma** | Uses shadow database for schema diffing. Doesn't support `CREATE INDEX CONCURRENTLY` directly. You'd use custom SQL migrations. |
| **golang-migrate** | Each migration file is one statement. If it fails, the schema version is set to "dirty" and requires manual `force` to fix. |

**Recommendation for Snich:**

1. **You will almost certainly never need `CREATE INDEX CONCURRENTLY`** for a VS Code extension's personal database. The tables will have at most tens of thousands of rows. Regular `CREATE INDEX` (which IS transactional) runs in milliseconds on small tables. `CONCURRENTLY` is for production databases with millions of rows that can't afford to lock the table during index creation.

2. **If you ever do need it:** Mark the migration as `transactional: false`. Run the DDL outside a transaction. Handle failures by:
   - Checking for invalid indexes before retry: `DROP INDEX IF EXISTS idx_name`
   - Making the DDL idempotent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_name ON ...`

3. **Use `IF NOT EXISTS` / `IF EXISTS` on ALL DDL** for idempotency, regardless of transaction wrapping. This makes manual recovery trivial.

**Implementation:**

```typescript
interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  transactional?: boolean;  // default true. Set false for CREATE INDEX CONCURRENTLY
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'create_base_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (...);
      CREATE TABLE IF NOT EXISTS raw_events (...);
      CREATE TABLE IF NOT EXISTS sessions (...);
    `,
    checksum: '...',
    // transactional: true (default)
  },
  {
    version: 7,
    name: 'add_fts_index_concurrently',
    sql: `
      DROP INDEX IF EXISTS idx_messages_fts_new;
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_fts_new
        ON messages USING gin(to_tsvector('english', content))
        WHERE deleted_at IS NULL;
    `,
    checksum: '...',
    transactional: false,
  },
];
```

---

### Q5: Schema Version Checking at Runtime

**Should Snich check schema version at startup?**

**Yes, but with a pragmatic approach:**

| Scenario | What happens without check | What happens with check |
|----------|---------------------------|------------------------|
| Snich v2 expects migration 005, only 001-003 applied | Queries fail with `column "X" does not exist` or `relation "Y" does not exist`. Confusing error messages. | Clear error: "Database schema is out of date. Expected migration 005, found 003. Please update." |
| Migrations 001-010 applied, but Snich v1 only knows about 001-003 | Queries work fine (extra columns/tables are ignored by SELECT). | Could warn but isn't necessary. |

**Recommendation:**

- **Check minimum version:** After connecting, verify that all migrations Snich knows about are applied. If not, **run them** (don't just refuse — the extension IS the migration runner).
- **Don't check maximum version:** Forward compatibility is fine. Extra tables/columns don't break older queries. A newer Snich version might have added migrations, and an older Snich in another window can coexist safely.
- **Reduce to a simple check:**

```typescript
async function ensureSchema(sql: postgres.Sql): Promise<void> {
  await runMigrations(sql);  // Idempotent — skips already-applied ones
  
  // Verify all expected migrations are now applied
  const applied = await sql`SELECT version FROM schema_migrations ORDER BY version`;
  const appliedSet = new Set(applied.map(r => r.version));
  
  const missing = ALL_MIGRATIONS.filter(m => !appliedSet.has(m.version));
  if (missing.length > 0) {
    throw new Error(`Schema migration failed. Missing: ${missing.map(m => m.name).join(', ')}`);
  }
}
```

**What if a column doesn't exist?** PostgreSQL returns a clear error: `ERROR: column "x" does not exist`. This crashes the query but not the extension (our error-handling wraps all DB calls). It IS a bug though — the schema check prevents it.

---

### Q6: Rollback Migrations (Down Migrations)

**Should Snich support down migrations?**

**No. Forward-only is the correct approach.**

| Factor | Analysis |
|--------|----------|
| **Industry consensus** | Flyway, Django (recommended), Rails (in practice), golang-migrate all recommend or enforce forward-only in production. Down migrations are for development convenience only. |
| **Our use case** | Snich is a personal tool. If a schema change is wrong, the user can drop the database and start fresh. There's no "production data" to preserve. |
| **Complexity cost** | Supporting down migrations doubles the migration code, introduces the risk of data loss (dropping columns), and adds a whole class of bugs (down migration doesn't perfectly reverse up migration). |
| **Multi-window safety** | Down migrations in a multi-window scenario are dangerous. Window 1 runs "down" while Window 2 expects the table to exist → crash. |
| **Practical recovery** | If Snich v2 has a broken migration, ship Snich v2.1 with a corrective migration that fixes the problem. This is the standard production pattern. |

**Recommendation:** Forward-only. If you need to "undo" a migration, create a new migration that reverses the change. If the database is corrupt beyond repair, `DROP DATABASE snich; CREATE DATABASE snich;` and let the extension re-populate from the JSONL files (the source of truth).

---

## AREA 2: SQLite Locking (Loop 14)

### Q1: Reading SQLite While VS Code is Writing

**Empirical finding from this machine:**

```
state.vscdb journal_mode = DELETE (NOT WAL)
```

No `-wal` or `-shm` sidecar files exist alongside `state.vscdb`.

**What this means:**

In DELETE journal mode (rollback journal), the locking model is:
- **Readers acquire SHARED lock** — multiple readers can coexist
- **Writers acquire EXCLUSIVE lock** — blocks ALL readers during write
- Reading during write → `SQLITE_BUSY` error

In WAL mode:
- Readers don't block writers and vice versa
- This would be ideal, but VS Code doesn't use it

**However, this matters less than you'd think because:**
- VS Code writes to `state.vscdb` very briefly (key-value store, tiny writes)
- The EXCLUSIVE lock duration is milliseconds
- SQLite's default busy timeout is 0 (immediate `SQLITE_BUSY`), but can be configured
- With `busy_timeout` set to even 1000ms, reads will retry automatically and almost never fail

**If Snich were to read `state.vscdb`:**
```typescript
// With better-sqlite3:
const db = new Database(path, { readonly: true });
db.pragma('busy_timeout = 5000');  // Wait up to 5s for locks to clear
```

### Q2: SQLite Library Choice

**This question is now MOOT (see Q6).** But for reference:

| Library | Pros | Cons |
|---------|------|------|
| `better-sqlite3` | Fastest, synchronous API, well-maintained | Native addon (node-gyp). Must ship prebuilds for each OS/arch/Node version. VS Code extension bundling headaches. |
| `sql.js` | Pure JS, zero native deps | Loads entire DB into memory. 2-4x slower. For a 458KB `state.vscdb`, memory is fine but approach is hacky. |
| `node-sqlite3` | Async API | Also native addon. Less maintained than `better-sqlite3`. |
| VS Code's built-in SQLite | Already loaded in the VS Code process | **Not exposed to extensions.** VS Code uses `@vscode/sqlite3` internally but there's no API for extensions to access it. |

### Q3: `state.vscdb` Structure

**Confirmed by live inspection:**

```sql
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
```

Single key-value table. That's it.

**Chat-related keys found:**

| Key | Size | Content |
|-----|------|---------|
| `chat.ChatSessionStore.index` | 804B | **Session index only** — maps sessionId → metadata (title, lastMessageDate, timing, stats). NO message content. |
| `memento/interactive-session` | 7990B | Legacy data — stores a limited `history` array with `inputText` only (the user's prompts, NOT assistant responses). This is UI memento state, not the session data. |
| `agentSessions.model.cache` | 413B | Agent session display metadata (label, description, status). |
| `GitHub.copilot-chat` | 318B | Extension-level storage (minimal metadata). |
| `chat.customModes` | 9521B | User-defined custom chat modes (system prompts). Not session data. |

**Critical finding:** `state.vscdb` stores **metadata and indexes only**. The actual chat session content (messages, responses, tool calls) lives in the JSONL files.

### Q4: File Locking on Windows

**Windows file locking behavior with SQLite:**

- Windows uses `LockFile()`/`LockFileEx()`/`UnlockFile()` for SQLite locks
- Unlike POSIX advisory locks, Windows locks are **mandatory** — they actually prevent concurrent access at the OS level
- If VS Code has `state.vscdb` open with a SHARED lock, another process CAN open it for reading (SHARED + SHARED is allowed)
- If VS Code is in the middle of a write (EXCLUSIVE lock), another process gets `SQLITE_BUSY`
- The `-wal` and `-shm` files don't apply here since VS Code uses DELETE journal mode

**Practical impact:** On Windows, reading `state.vscdb` while VS Code has it open works fine. The EXCLUSIVE lock during writes lasts only milliseconds. With `busy_timeout`, reads succeed reliably.

### Q5: Performance Impact of Periodic Reading

**If Snich read `state.vscdb` every 30 seconds:**

- Read operation on a 458KB SQLite DB: <1ms
- Lock contention: negligible (write locks are held for microseconds)
- File descriptor usage: 1 additional FD (not a concern)
- No measurable impact on VS Code performance

**But again, this is moot — see Q6.**

---

### Q6: DO WE EVEN NEED SQLite READING?

## **NO. SQLite reading is NOT needed.**

This is the most important finding. Here's the definitive evidence:

### Evidence 1: VS Code Source Code (`chatSessionStore.ts`)

The `getStorageLocation` method reveals the storage architecture:

```typescript
private getStorageLocation(chatSessionId: string) {
  return {
    flat: joinPath(this.storageRoot, `${chatSessionId}.json`),     // <1.109 format
    log: joinPath(this.storageRoot, `${chatSessionId}.jsonl`),      // >=1.109 format
  };
}
```

Where `storageRoot` is:
```typescript
joinPath(this.environmentService.workspaceStorageHome, workspaceId, 'chatSessions')
```

**Chat session CONTENT is stored exclusively in JSONL files** (or legacy `.json` files for pre-1.109 sessions). The JSONL format is an append-only operation log written via `ChatSessionOperationLog`.

### Evidence 2: `state.vscdb` Stores Only the Index

The `ChatIndexStorageKey = 'chat.ChatSessionStore.index'` is stored via `IStorageService`, which maps to `state.vscdb`'s `ItemTable`. The value is pure metadata:

```json
{
  "version": 1,
  "entries": {
    "<session-uuid>": {
      "sessionId": "...",
      "title": "...",
      "lastMessageDate": 1776444358817,
      "timing": { "created": ..., "lastRequestStarted": ..., "lastRequestEnded": ... },
      "isEmpty": true,
      "lastResponseState": 1
    }
  }
}
```

No message content. Just enough metadata to show session titles in the sidebar.

### Evidence 3: `memento/interactive-session` is Legacy UI State

The `memento/interactive-session` key stores only `inputText` (user prompts) for history/autocomplete purposes. It does NOT store assistant responses, tool calls, or full conversation data. This is VS Code's general-purpose UI memento system, not the chat persistence layer.

### Evidence 4: Live File System Confirms Coexistence

On this machine (VS Code 1.116+, Copilot Chat built-in):
```
workspaceStorage/<hash>/
├── chatSessions/
│   ├── 107237b3-...jsonl        ← ACTIVE CHAT SESSION (1.7KB)
│   └── 83695f24-...jsonl        ← ACTIVE CHAT SESSION (2.8MB)
├── chatEditingSessions/         ← Editor state for agent mode edits
├── GitHub.copilot-chat/         ← Copilot extension storage (transcripts, debug logs, memory)
└── state.vscdb                  ← General workspace state (458KB, key-value store)
```

The JSONL files in `chatSessions/` ARE the authoritative source. They exist. They are actively written to. The `state.vscdb` merely indexes them.

### Evidence 5: Even After Copilot Became Built-In

Since Copilot Chat became built-in (1.116+), the storage path changed from being under `GitHub.copilot-chat/` to being directly under `chatSessions/` at the workspace storage root. But the FORMAT is still JSONL. The built-in integration didn't move chat data into SQLite. The `chatSessionStore.ts` code proves this — it's in the core VS Code codebase (`src/vs/workbench/contrib/chat/`), not in any extension.

### Evidence 6: The `chat.useLogSessionStorage` Config

```typescript
log: this.configurationService.getValue('chat.useLogSessionStorage') !== false
  ? joinPath(this.storageRoot, `${chatSessionId}.jsonl`)
  : undefined,
```

JSONL is the **default** and has been since 1.109. The `.json` flat format is the fallback. There is no SQLite code path for session storage.

---

## FINAL RECOMMENDATIONS

### Migration Safety (Area 1):

1. **Use `pg_advisory_lock` (session-level)** with a fixed lock ID for migration serialization. Block, don't skip.
2. **Wrap each migration in a transaction** (PostgreSQL DDL is transactional).
3. **Use `IF NOT EXISTS` / `IF EXISTS`** on all DDL for idempotency as defense-in-depth.
4. **Don't support `CREATE INDEX CONCURRENTLY`** — unnecessary for a personal extension database. If ever needed, mark migration as `transactional: false`.
5. **Forward-only migrations.** No down/rollback support.
6. **Run migrations on connect** — the advisory lock makes it safe for multi-window. Add a schema version assertion after migration completes.
7. **Always unlock in `finally`** — session-level advisory locks are NOT automatically released on transaction commit.

### SQLite Reading (Area 2):

1. **Do NOT add SQLite as a dependency.** It's unnecessary complexity (especially native module bundling).
2. **JSONL files are the sole data source.** The `chatSessions/*.jsonl` files contain all chat session data.
3. **`state.vscdb` stores only the session index** (titles, timestamps, metadata). If you need this metadata, you can derive it from the JSONL content during replay — it's redundant.
4. **The `chatSessions/` directory is now at the workspace storage root** (not under any extension subfolder) for VS Code 1.109+.
5. **Legacy `.json` format support** may be needed for pre-1.109 sessions (single JSON blob instead of append-only JSONL log). Both formats coexist in the `chatSessions/` directory.

### Updated Architecture Impact:

The ARCHITECTURE_v2.md section 2.1 should be updated:
- Remove the statement "check for `state.vscdb` SQLite (newer path)" from the auto-discovery algorithm
- The `chatSessions/` subfolder is now at the WORKSPACE STORAGE ROOT level, not under an extension subfolder
- No SQLite dependency needed
- The `GitHub.copilot-chat/` subfolder stores transcripts, debug-logs, and memory-tool data (potentially useful for richer data extraction, but NOT the primary chat sessions)
