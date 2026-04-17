# Snich — Production Research Report

## Area 1: Multi-Window Edge Cases

### 1.1 Do Two Windows Opening the Same Workspace Share a `workspaceStorage` Hash Folder?

**Yes.** The `workspaceStorage` hash is deterministic — it's derived from the workspace URI (folder path). If Window 1 and Window 2 both open `C:\Projects\MyApp`, they both map to the same hash folder (e.g., `5e4f5a81d584b0f638a96f4e88534809`). Both windows read/write to the same `chatSessions/*.jsonl` files inside that folder.

Key implications:
- Both extension host instances will set up `FileSystemWatcher` on the same paths
- Both will receive OS-level file change notifications for the same files
- VS Code itself handles concurrent `.jsonl` writes via internal locking, but our extension is read-only on these files — no write conflicts from our side
- The `ExtensionContext.storageUri` for our extension is also per-workspace-hash, so two windows with the same workspace share the same extension storage folder too

### 1.2 Concurrent PostgreSQL Writes from Multiple Extension Hosts

**PostgreSQL handles concurrent connections natively.** Two extension hosts can safely write to the same database. The coordination needed:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| Raw event dedup | `INSERT ... ON CONFLICT (event_hash) DO NOTHING` | Exactly-once ingestion |
| Session materialization | `pg_advisory_xact_lock(hashtext(session_uuid))` | Serialize updates to same session |
| Connection pooling | `pg.Pool` with `max: 3` per window | Keep total connections bounded |

**Recommended pool sizing:** 3 connections × N windows. PostgreSQL's default `max_connections` is 100, so even 10 windows (30 connections) is fine.

### 1.3 Race Condition: Two Windows Detect Same File Change

The exact scenario: Window 1 and Window 2 both watch the same `.jsonl` file. File changes. Both detect it within milliseconds. Both try to insert the same raw events.

**Raw event layer — solved:**
```sql
INSERT INTO raw_events (event_hash, ...) VALUES ($1, ...) 
ON CONFLICT (event_hash) DO NOTHING RETURNING id;
```
- Window 1 inserts first → gets `RETURNING id` with the new row ID
- Window 2 inserts second → `ON CONFLICT DO NOTHING`, `RETURNING id` returns **no rows**
- Window 2 detects this (empty result set) and **skips materialization**

**Materialization layer — needs advisory lock:**

The risk: Even with raw event dedup, both windows might see a batch of new events. Window 1 wins some inserts, Window 2 wins others. Both then try to update `sessions`/`messages` tables for the same session concurrently, causing inconsistent state.

**Solution:** Use `pg_advisory_xact_lock` keyed on session UUID before materializing:

```typescript
async materializeSession(sessionUuid: string, events: RawEvent[]): Promise<void> {
    const client = await this.pool.connect();
    try {
        await client.query('BEGIN');
        // Acquire session-level advisory lock (blocks other windows working on same session)
        await client.query('SELECT pg_advisory_xact_lock($1)', [hashText(sessionUuid)]);
        
        // Re-read current session state from DB (may have been updated by other window)
        const currentState = await this.getSessionState(client, sessionUuid);
        
        // Apply only events not yet reflected in current state
        for (const event of events) {
            const inserted = await this.tryInsertRawEvent(client, event);
            if (inserted) {
                await this.applyToMaterialized(client, sessionUuid, event, currentState);
            }
        }
        
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
```

### 1.4 `pg_advisory_lock` vs. Row-Level Locking

**Recommendation: Use `pg_advisory_xact_lock` (transaction-scoped advisory locks).**

| Approach | Pros | Cons |
|----------|------|------|
| `pg_advisory_xact_lock` | Auto-released on commit/rollback. No deadlock with inserts. Works even before the row exists. | Limited to integer keys (use `hashtext()`) |
| `SELECT ... FOR UPDATE` (row-level) | Standard SQL, well-understood | Requires row to already exist. Deadlock risk if multiple rows locked in different orders |
| `pg_advisory_lock` (session-scoped) | More flexible | Must manually release. Leak risk if extension crashes |

**Why advisory locks win for Snich:**
- Sessions may not exist in DB yet when first events arrive (can't `SELECT FOR UPDATE` a non-existent row)
- Only one "scope" of locking needed (per session UUID)
- Transaction-scoped variant auto-cleans up on crash
- Hashing: `pg_advisory_xact_lock(hashtext('session-uuid-here'))` — `hashtext()` returns int4, which is fine since collision probability across ~1000 active sessions is negligible

### 1.5 VS Code Remote (SSH, WSL, Containers)

Based on the official VS Code Remote Extensions documentation:

**Architecture:** VS Code distinguishes **UI Extensions** (run locally) and **Workspace Extensions** (run where the workspace is). Snich should be a **Workspace Extension** because it needs file system access to `workspaceStorage`.

| Remote Mode | Where Extension Runs | Where `workspaceStorage` Lives | Network Path to PostgreSQL |
|-------------|---------------------|-------------------------------|---------------------------|
| **Local** | Local machine | Local disk (`%APPDATA%\Code\User\workspaceStorage\`) | `localhost:5432` |
| **SSH** | Remote SSH host (VS Code Server) | Remote host (`~/.config/Code/User/workspaceStorage/`) | Must connect to PG on remote host or tunnel back |
| **WSL** | Inside WSL (VS Code Server) | WSL filesystem (`~/.config/Code/User/workspaceStorage/`) | Connect to PG in WSL or on Windows host |
| **Container** | Inside container (VS Code Server) | Container filesystem | Connect to PG in container or on host via network |

**Key implications for Snich:**

1. **`workspaceStorage` path varies by platform.** Use `ExtensionContext.globalStorageUri` parent path or compute from known base paths. Never hardcode Windows paths.

2. **PostgreSQL connectivity.** In remote scenarios, `localhost` means the remote machine, not the user's desktop. Options:
   - Run PostgreSQL on the same machine as the extension (recommended for simplicity)
   - Support configurable connection strings so users can point to any PG instance
   - For SSH/container: PostgreSQL connection string must be reachable from the remote host

3. **`SecretStorage` in remote mode.** From the docs: "The API will always store the secrets on the client side but you can use this API regardless of where your extension is running and retrieve the same secret values." This means credentials stored via `SecretStorage` are accessible in remote mode — good.

4. **Extension kind declaration in `package.json`:**
```json
{
    "extensionKind": ["workspace"]
}
```
This ensures Snich always runs where the files are. If we also need UI components (status bar, webviews), those work from workspace extensions too.

---

## Area 2: Production VS Code Extension Patterns

### 2.1 Graceful Shutdown (Extension Deactivation)

The `deactivate()` function must return a `Promise` if cleanup is async. VS Code gives limited time (~5 seconds) before force-killing the extension host.

```typescript
export async function deactivate(): Promise<void> {
    // 1. Stop file watchers (synchronous disposal)
    watcherDisposable?.dispose();
    chokidarWatcher?.close();
    
    // 2. Flush pending event queue to DB
    await eventProcessor.flushPendingEvents();
    
    // 3. Mark instance as inactive
    await db.query(
        'UPDATE extension_instances SET is_active = false WHERE instance_id = $1',
        [instanceId]
    );
    
    // 4. Close database pool (drains gracefully)
    await pool.end();
    
    // 5. Log final state
    outputChannel.appendLine(`[Snich] Deactivated. Processed ${stats.totalEvents} events.`);
}
```

**Patterns from major extensions:**
- **GitLens:** Disposes all subscriptions pushed to `context.subscriptions`. Uses `Disposable.from()` to group related resources.
- **ESLint:** Shuts down language server client in `deactivate()`. Awaits `client.stop()`.
- **Best practice:** Push everything disposable to `context.subscriptions` so VS Code auto-disposes on deactivation. Use `deactivate()` only for async cleanup like flushing DB connections.

### 2.2 Error Recovery Without Crashing the Extension Host

**Critical rule:** Never let an unhandled promise rejection or thrown error escape to the extension host. A crash in the extension host kills ALL extensions in that window.

```typescript
// PATTERN: Wrap every entry point
function safeHandler<T extends (...args: any[]) => any>(fn: T, context: string): T {
    return ((...args: any[]) => {
        try {
            const result = fn(...args);
            if (result && typeof result.then === 'function') {
                return result.catch((err: Error) => {
                    logger.error(`[${context}] ${err.message}`, err.stack);
                    // Optionally show user-facing notification for critical errors
                    // vscode.window.showErrorMessage(`Snich: ${err.message}`);
                });
            }
            return result;
        } catch (err: any) {
            logger.error(`[${context}] ${err.message}`, err.stack);
        }
    }) as any;
}

// Usage
watcher.onDidChange(safeHandler(handleFileChange, 'FileWatcher.onChange'));
```

**Error classification strategy:**
| Error Type | Action |
|-----------|--------|
| DB connection failed | Queue events in memory/disk. Retry with exponential backoff. Show status bar warning. |
| File read error (ENOENT, EPERM) | Log and skip. File may have been deleted between event and read. |
| JSONL parse error (malformed line) | Log the raw line. Skip it. Continue processing remaining lines. |
| Schema/migration error | Show error notification. Disable processing until resolved. |
| Out of memory / resource exhaustion | Reduce queue sizes. Log diagnostics. |

### 2.3 Logging Best Practices

Use `LogOutputChannel` (available since VS Code 1.74) for structured logging with levels:

```typescript
const logger = vscode.window.createOutputChannel('Snich', { log: true });

// Automatically respects VS Code's log level setting
logger.trace('Processing line 42 of session.jsonl');  // Only in verbose mode
logger.debug('Raw event hash: abc123');
logger.info('Connected to PostgreSQL at localhost:5432');
logger.warn('DB connection lost, queuing 15 events');
logger.error('Failed to parse JSONL line', error);
```

**Key practices:**
- `LogOutputChannel` supports `.trace()`, `.debug()`, `.info()`, `.warn()`, `.error()` — all filtered by `env.logLevel`
- Never log credentials or full connection strings
- Log event counts and processing durations, not individual event contents (privacy)
- Use structured context: `logger.info('Session materialized', { sessionId, eventCount, durationMs })`
- For telemetry, use `vscode.env.createTelemetryLogger()` with a custom `TelemetrySender`

### 2.4 Memory Management

**Long-running watchers:**
```typescript
// chokidar watcher — bounded event queue
const watcher = chokidar.watch(globPattern, {
    persistent: true,
    ignoreInitial: false,    // process existing files on startup
    awaitWriteFinish: {      // wait for write to complete before firing
        stabilityThreshold: 300,
        pollInterval: 100
    },
    depth: 2                 // workspaceStorage/<hash>/chatSessions/ — only 2 levels deep
});
```

**Connection pool lifecycle:**
- Create pool lazily (only when first DB operation needed)
- Set `idleTimeoutMillis: 30000` to release unused connections
- Set `max: 3` per window — this is more than enough for our write pattern
- Monitor pool with `pool.on('error', ...)` and `pool.on('connect', ...)`

**JSONL Replayer state:**
- Each replayer holds the full session state in memory. For a typical chat session (~50 turns), this is ~50KB.
- Watching 100 active sessions = ~5MB — negligible
- Replayers for inactive sessions should be garbage collected after a timeout

**Bounded in-memory queue:**
```typescript
const MAX_QUEUE_SIZE = 1000;
const DISK_SPILL_PATH = path.join(globalStoragePath, 'event-queue.jsonl');
```

### 2.5 Startup Performance

**Activation event:** Use `onStartupFinished` — Snich should NOT use `*` (which delays VS Code startup):

```json
{
    "activationEvents": ["onStartupFinished"]
}
```

This ensures VS Code is fully loaded before Snich initializes watchers and DB connections. The tradeoff: we might miss file changes during the first ~1-2 seconds of startup. This is acceptable because:
- On activation, we do a full scan of `watch_state` vs current files to catch anything missed
- Chat sessions are rarely modified in the first second of VS Code startup

**Lazy loading pattern:**
```typescript
export async function activate(context: vscode.ExtensionContext) {
    // Immediate: register commands, status bar (lightweight)
    registerCommands(context);
    createStatusBar(context);
    
    // Deferred: DB connection, watchers (heavyweight)
    // Use setImmediate or setTimeout to not block activation
    setTimeout(async () => {
        try {
            await initializeDatabase();
            await startWatchers();
            await reconcileMissedChanges();
        } catch (err) {
            logger.error('Failed to initialize', err);
            statusBar.text = '$(warning) Snich: Disconnected';
        }
    }, 0);
}
```

### 2.6 Extension Size & Marketplace Limits

**Marketplace limit:** 200MB per VSIX package. Typical well-bundled extensions are 1-10MB.

**Bundling with esbuild (recommended over webpack for speed):**
```javascript
// esbuild.js
const esbuild = require('esbuild');
await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],  // provided by VS Code runtime
    // pg (node-postgres) is pure JS — bundles fine
    // chokidar has native deps — needs external or careful handling
});
```

**`.vscodeignore` for minimal package:**
```
.vscode/
node_modules/
src/
out/
*.ts
tsconfig.json
esbuild.js
.eslintrc*
```

**Native dependency handling:**
- `pg` (node-postgres): Pure JavaScript, bundles cleanly with esbuild
- `chokidar`: Has optional native dependency (`fsevents` on macOS). Use `esbuild`'s `--external:fsevents` or switch to Node.js `fs.watch` / VS Code's `createFileSystemWatcher` where possible
- Avoid native modules when possible to support all platforms and remote scenarios

**Expected Snich bundle size:** ~500KB-2MB (pg + crypto + business logic)

---

## Area 3: Security & Enterprise Compliance

### 3.1 Database Credential Storage

**Primary: VS Code `SecretStorage` API**

```typescript
// Store
await context.secrets.store('snich.dbPassword', password);

// Retrieve
const password = await context.secrets.get('snich.dbPassword');

// Delete
await context.secrets.delete('snich.dbPassword');

// React to changes
context.secrets.onDidChange(e => {
    if (e.key === 'snich.dbPassword') {
        reconnectDatabase();
    }
});
```

**Reliability analysis:**
- **Desktop (Electron):** Uses Electron's `safeStorage` API, which encrypts with OS keychain (Windows Credential Manager / macOS Keychain / GNOME Keyring / KWallet)
- **Remote:** Secrets are always stored on the **client side** (the user's machine), not the remote host. The API transparently proxies across the remote connection.
- **Limitation:** `SecretStorage` only stores strings. Connection objects must be serialized.
- **Failure mode:** If OS keychain is locked or unavailable, `get()` returns `undefined`. Extension must handle this gracefully.
- **Not synced:** Secrets are NOT synced across machines via Settings Sync (by design).

**Recommended credential flow:**
```
1. On first activation: prompt user for connection details
2. Store password in SecretStorage, other config in settings.json (host, port, database, user)
3. On subsequent activations: read config from settings + password from SecretStorage
4. If SecretStorage returns undefined: prompt user again
5. Support connection string override via environment variable (see 3.2)
```

**Settings schema (non-sensitive, in `package.json` contributes):**
```json
{
    "snich.database.host": { "type": "string", "default": "localhost" },
    "snich.database.port": { "type": "number", "default": 5432 },
    "snich.database.name": { "type": "string", "default": "snich" },
    "snich.database.user": { "type": "string", "default": "snich" },
    "snich.database.sslMode": { "type": "string", "enum": ["disable", "require", "verify-full"], "default": "prefer" }
}
```

### 3.2 Environment Variable Support for CI/CD and Docker

**Yes — support `SNICH_DATABASE_URL` as an override:**

```typescript
function getConnectionConfig(): pg.PoolConfig {
    // Priority: env var > SecretStorage + settings > defaults
    const envUrl = process.env.SNICH_DATABASE_URL;
    if (envUrl) {
        return { connectionString: envUrl, ssl: parseSslFromUrl(envUrl) };
    }
    
    const config = vscode.workspace.getConfiguration('snich.database');
    return {
        host: config.get('host', 'localhost'),
        port: config.get('port', 5432),
        database: config.get('name', 'snich'),
        user: config.get('user', 'snich'),
        password: cachedPassword, // from SecretStorage
    };
}
```

**Additional env vars to support:**
| Variable | Purpose |
|----------|---------|
| `SNICH_DATABASE_URL` | Full PostgreSQL connection string (`postgres://user:pass@host:port/db`) |
| `SNICH_DATABASE_SSL_CA` | Path to CA certificate for SSL connections |
| `SNICH_DISABLE` | Set to `true` to disable Snich completely (useful in CI) |

**Security note:** When using `SNICH_DATABASE_URL`, the password is in an environment variable. This is standard for container deployments (12-factor app pattern) but should be documented as less secure than `SecretStorage` for desktop use.

### 3.3 SOC2 / GDPR Considerations

**Data classification:** Chat data stored by Snich is a mix of:
- User prompts (may contain PII, proprietary code, business logic)
- AI responses (may contain generated code, explanations)
- Metadata (timestamps, session IDs, workspace paths)

**GDPR implications:**

| Requirement | Snich Implementation |
|-------------|---------------------|
| **Right to erasure (Art. 17)** | Provide `Snich: Purge All Data` command that truly deletes (not soft-deletes) all data. Also support per-session hard delete. |
| **Data minimization (Art. 5)** | Don't store more than needed. Consider option to hash/omit code snippets. |
| **Storage limitation** | Implement configurable retention policy (see 3.4) |
| **Lawful basis** | Snich stores data locally by user's explicit choice (consent). Document this in extension description. |
| **Data portability (Art. 20)** | Export commands already planned (JSON, Markdown) |
| **Processing records** | The `raw_events` table with timestamps serves as a processing log |

**SOC2 implications:**

| Control | Implementation |
|---------|----------------|
| **Access control** | PostgreSQL role-based access. Document recommended setup with dedicated `snich` user with minimal privileges. |
| **Audit logging** | `raw_events` is immutable audit log. `extension_instances` tracks which processes accessed data. |
| **Encryption in transit** | Support `sslmode=require` or `verify-full` for PostgreSQL connections. |
| **Encryption at rest** | See 3.6 |
| **Data retention** | See 3.4 |

**Recommendation:** Add a "Privacy & Compliance" section to extension README with:
- What data is collected and stored
- Where it's stored (local PostgreSQL only — no cloud transmission)
- How to delete all data
- Retention policy configuration

### 3.4 Data Retention Policy

**Implement configurable auto-purge:**

```json
{
    "snich.retention.enabled": { "type": "boolean", "default": false },
    "snich.retention.days": { "type": "number", "default": 90, "minimum": 7 },
    "snich.retention.purgeSchedule": { 
        "type": "string", 
        "enum": ["daily", "weekly"], 
        "default": "weekly" 
    }
}
```

**Purge implementation:**
```sql
-- Run on schedule (triggered by extension, not a cron job)
-- Step 1: Hard-delete old raw events (truly remove, not soft delete)
DELETE FROM raw_events 
WHERE detected_at < NOW() - INTERVAL '90 days';

-- Step 2: Hard-delete old message versions
DELETE FROM message_versions 
WHERE created_at < NOW() - INTERVAL '90 days';

-- Step 3: Hard-delete old messages (including soft-deleted ones)
DELETE FROM messages 
WHERE created_at < NOW() - INTERVAL '90 days';

-- Step 4: Hard-delete old sessions
DELETE FROM sessions 
WHERE last_modified_at < NOW() - INTERVAL '90 days';

-- Step 5: Hard-delete old snapshots
DELETE FROM session_snapshots 
WHERE created_at < NOW() - INTERVAL '90 days';

-- Step 6: VACUUM to reclaim disk space
VACUUM ANALYZE;
```

**Purge trigger:** Run purge check on extension activation, then every 24 hours while extension is active. Use a simple `setInterval` — no external scheduler needed.

### 3.5 Proprietary Code in Chat Data

**This is the biggest enterprise concern.** Chat conversations frequently contain:
- Proprietary source code pasted by the user
- Internal API designs and architecture discussions
- Security-sensitive information (credentials accidentally shared with Copilot)
- Business logic and trade secrets

**Mitigations:**

1. **Local-only storage:** Snich stores data ONLY in a local PostgreSQL database. No data leaves the machine. This is the primary defense. Document prominently.

2. **Optional content redaction:**
```json
{
    "snich.privacy.redactCodeBlocks": { 
        "type": "boolean", 
        "default": false,
        "description": "Replace code blocks with [CODE REDACTED] in stored messages" 
    },
    "snich.privacy.hashContent": {
        "type": "boolean",
        "default": false,
        "description": "Store content hashes instead of full text (disables search)"
    }
}
```

3. **PostgreSQL access controls:** Document recommended setup:
```sql
-- Create dedicated user with minimal privileges
CREATE USER snich WITH PASSWORD '...';
GRANT CONNECT ON DATABASE snich TO snich;
GRANT USAGE ON SCHEMA public TO snich;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO snich;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO snich;
-- No SUPERUSER, no CREATEDB, no CREATEROLE
```

4. **Network binding:** Recommend PostgreSQL listens only on `localhost`:
```
# postgresql.conf
listen_addresses = 'localhost'
```

### 3.6 Encryption at Rest

**PostgreSQL-level encryption options:**

| Approach | Complexity | Protection |
|----------|-----------|------------|
| **OS-level disk encryption** (BitLocker, LUKS, FileVault) | Zero app changes | Protects against physical disk theft |
| **PostgreSQL TDE** (Transparent Data Encryption) | PostgreSQL 16+ enterprise or community patches | Protects data files at rest |
| **Column-level encryption** (`pgcrypto`) | App changes needed | Protects specific sensitive columns |
| **Application-level encryption** | Most complex | Full control, portable |

**Recommendation:** 

For most users, **OS-level disk encryption is sufficient** and requires zero changes to Snich. Document this as a recommendation.

For enterprise users needing column-level encryption:

```typescript
// Application-level encryption for message content
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function encrypt(text: string, key: Buffer): { encrypted: string; iv: string; tag: string } {
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return {
        encrypted,
        iv: iv.toString('base64'),
        tag: (cipher as any).getAuthTag().toString('base64')
    };
}
```

**Settings:**
```json
{
    "snich.encryption.enabled": { "type": "boolean", "default": false },
    "snich.encryption.keySource": {
        "type": "string",
        "enum": ["secretStorage", "envVar", "keyFile"],
        "default": "secretStorage"
    }
}
```

**Tradeoff:** Application-level encryption of `content` columns disables PostgreSQL full-text search (`tsvector`). If encryption is enabled, search must decrypt in-application, which is much slower. Consider encrypting only the `messages.content` and `message_versions.content` columns, leaving metadata searchable.

---

## Summary of Key Recommendations

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Multi-window dedup | `INSERT ... ON CONFLICT DO NOTHING` + `pg_advisory_xact_lock` | Deterministic, crash-safe, no external coordinator |
| Locking strategy | Transaction-scoped advisory locks per session UUID | Auto-release on crash, works before row exists |
| Extension kind | `"extensionKind": ["workspace"]` | Must run where files are (handles remote scenarios) |
| Activation | `onStartupFinished` | Don't delay VS Code startup |
| Bundler | esbuild | Fast builds, clean bundling of `pg` |
| Credential storage | `SecretStorage` for desktop, `SNICH_DATABASE_URL` env var for containers | Follows VS Code best practices + 12-factor |
| Logging | `LogOutputChannel` with `{ log: true }` | Structured levels, respects user settings |
| Error handling | Wrap every entry point, classify errors, never crash extension host | Production resilience |
| Retention | Configurable auto-purge (default off, min 7 days) | GDPR compliance, disk management |
| Encryption | Recommend OS-level disk encryption; offer opt-in column-level via `pgcrypto` or app-level AES-256-GCM | Pragmatic security layering |
| Code in chat data | Local-only storage, optional content redaction, document prominently | Enterprise trust |
| Connection pool | `max: 3` per window, lazy init, auto-reconnect with bounded retry queue | Resource efficiency |
