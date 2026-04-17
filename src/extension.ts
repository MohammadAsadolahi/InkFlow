import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { loadConfig } from './config';
import { createPool, healthCheck } from './db/connection';
import { runMigrations } from './db/migrations';
import { WorkspaceRepo } from './db/repos/workspaceRepo';
import { ChatFileWatcher } from './watcher/chatFileWatcher';
import { EventProcessor } from './processor/eventProcessor';
import { LocalEventQueue } from './processor/localQueue';
import { discoverWorkspaces, listChatFiles } from './discovery/workspaceResolver';
import type postgres from 'postgres';
import type { DiscoveredWorkspace, SnichConfig } from './types';
import * as fs from 'fs';

let sql: postgres.Sql | null = null;
let watcher: ChatFileWatcher | null = null;
let processor: EventProcessor | null = null;
let localQueue: LocalEventQueue | null = null;
let scanInterval: ReturnType<typeof setInterval> | null = null;
let discoveryInterval: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;
const instanceId = crypto.randomUUID();

// Cache workspace IDs to avoid repeated DB lookups
const workspaceIdCache = new Map<string, number>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const log = vscode.window.createOutputChannel('Snich', { log: true });
    context.subscriptions.push(log);

    log.info(`Snich activating (instance: ${instanceId})`);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('snich.showStatus', () => showStatus(log)),
        vscode.commands.registerCommand('snich.reconnect', () => reconnect(context, log)),
        vscode.commands.registerCommand('snich.scanNow', () => scanNow(log)),
    );

    // Lazy init — don't block activation
    setTimeout(async () => {
        try {
            await initializeSnich(context, log);
        } catch (err) {
            log.error('Snich initialization failed', err);
            vscode.window.showWarningMessage('Snich: Failed to connect to database. Check Output panel for details.');
        }
    }, 0);
}

export async function deactivate(): Promise<void> {
    isShuttingDown = true;

    // 1. Stop watchers + clear timers (sync)
    watcher?.dispose();
    if (scanInterval) clearInterval(scanInterval);
    if (discoveryInterval) clearInterval(discoveryInterval);

    // 2. Flush pending events to disk
    try {
        await localQueue?.flushToDisk();
    } catch { /* best effort */ }

    // 3. Shutdown processor
    processor?.shutdown();

    // 4. Deregister instance
    try {
        if (sql) {
            await sql`UPDATE extension_instances SET is_active = FALSE WHERE instance_id = ${instanceId}`;
        }
    } catch { /* best effort */ }

    // 5. Close pool (max 2s)
    try {
        if (sql) await sql.end({ timeout: 2 });
    } catch { /* best effort */ }
}

async function initializeSnich(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel,
): Promise<void> {
    const config = loadConfig(vscode.workspace);

    if (!config.watcher.enabled) {
        log.info('Snich watcher is disabled');
        return;
    }

    // Get password from SecretStorage or env var
    let password: string;
    if (process.env.SNICH_DATABASE_URL) {
        password = ''; // Not needed when using connection URL
    } else {
        const stored = await context.secrets.get('snich.database.password');
        if (!stored) {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter PostgreSQL password for Snich',
                password: true,
                ignoreFocusOut: true,
            });
            if (!input) {
                log.warn('No password provided, Snich will not start');
                return;
            }
            await context.secrets.store('snich.database.password', input);
            password = input;
        } else {
            password = stored;
        }
    }

    // Create connection pool
    sql = createPool({
        config: config.database,
        password,
        onNotice: (notice) => log.debug(`PG notice: ${notice.message}`),
    });

    // Health check
    const healthy = await healthCheck(sql);
    if (!healthy) {
        throw new Error('Database health check failed');
    }
    log.info('Database connected');

    // Run migrations
    await runMigrations(sql, log);
    log.info('Migrations complete');

    // Register instance
    await sql`
        INSERT INTO extension_instances (instance_id, pid, started_at)
        VALUES (${instanceId}, ${process.pid}, NOW())
        ON CONFLICT (instance_id) DO UPDATE SET
            is_active = TRUE, last_heartbeat = NOW(), pid = ${process.pid}
    `;

    // Ensure global storage directory exists
    const globalStoragePath = context.globalStorageUri.fsPath;
    fs.mkdirSync(globalStoragePath, { recursive: true });

    // Initialize local queue
    localQueue = new LocalEventQueue(globalStoragePath, instanceId, log);

    // Recover orphaned queue files
    const recovered = await LocalEventQueue.recoverOrphans(
        globalStoragePath,
        async () => { /* Will be handled by processor */ },
        instanceId,
        log,
    );
    if (recovered > 0) {
        log.info(`Recovered ${recovered} events from crashed instances`);
    }

    // Initialize processor
    processor = new EventProcessor(sql, {
        instanceId,
        filterInputState: config.ingestion.filterInputState,
    }, log);

    // Initialize watcher
    watcher = new ChatFileWatcher({
        onFileChanged: (filePath) => handleFileChanged(filePath, config, log),
        onError: (dir, err) => log.warn(`Watcher error for ${dir}: ${err.message}`),
    }, config.watcher.debounceMs, log);

    // Initial discovery + scan
    await discoverAndWatch(config, log);

    // Periodic scan (belt-and-suspenders)
    scanInterval = setInterval(() => {
        if (!isShuttingDown) periodicScan(config, log);
    }, config.watcher.periodicScanSeconds * 1000);

    // Periodic workspace discovery (find new workspaces)
    discoveryInterval = setInterval(() => {
        if (!isShuttingDown) discoverAndWatch(config, log).catch(err =>
            log.error('Discovery error', err)
        );
    }, 60_000);

    // Handle config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('snich.database')) {
                const action = await vscode.window.showInformationMessage(
                    'Snich: Database settings changed. Reconnect now?',
                    'Reconnect', 'Later'
                );
                if (action === 'Reconnect') await reconnect(context, log);
            }
            if (e.affectsConfiguration('snich.watcher.debounceMs') && watcher) {
                watcher.debounceMs = loadConfig(vscode.workspace).watcher.debounceMs;
            }
        })
    );

    // Dispose watcher on deactivate (sync cleanup)
    context.subscriptions.push({ dispose: () => watcher?.dispose() });

    log.info('Snich fully initialized');
}

async function discoverAndWatch(config: SnichConfig, log: vscode.LogOutputChannel): Promise<void> {
    if (!sql || !watcher) return;

    const workspaces = discoverWorkspaces(config.watcher.watchVariants);
    log.info(`Discovered ${workspaces.length} workspaces`);

    for (const ws of workspaces) {
        await ensureWorkspaceId(ws);
        watcher.watchDirectory(ws.chatSessionsDir);
    }
}

async function ensureWorkspaceId(ws: DiscoveredWorkspace): Promise<number> {
    const cached = workspaceIdCache.get(ws.storageHash);
    if (cached) return cached;

    if (!sql) throw new Error('DB not connected');
    const repo = new WorkspaceRepo(sql);
    const id = await repo.upsert(ws.storageHash, ws.variant, ws.folderUri, ws.displayName);
    workspaceIdCache.set(ws.storageHash, id);
    return id;
}

async function handleFileChanged(filePath: string, config: SnichConfig, log: vscode.LogOutputChannel): Promise<void> {
    if (isShuttingDown || !processor || !sql) return;

    try {
        // Determine workspace ID from file path
        const workspaceId = await resolveWorkspaceIdFromPath(filePath, config);
        if (!workspaceId) {
            log.warn(`Could not resolve workspace ID for ${filePath}`);
            return;
        }

        const ingested = await processor.processFileChange(filePath, workspaceId);
        if (ingested > 0) {
            log.debug(`Ingested ${ingested} events from ${filePath}`);
        }
    } catch (err) {
        log.error(`Error processing ${filePath}`, err);
    }
}

async function resolveWorkspaceIdFromPath(filePath: string, config: SnichConfig): Promise<number | null> {
    // Extract storage hash from path: .../workspaceStorage/<hash>/chatSessions/...
    const parts = filePath.replace(/\\/g, '/').split('/');
    const wsIdx = parts.indexOf('workspaceStorage');
    if (wsIdx < 0 || wsIdx + 1 >= parts.length) return null;

    const storageHash = parts[wsIdx + 1];
    const cached = workspaceIdCache.get(storageHash);
    if (cached) return cached;

    if (!sql) return null;
    const repo = new WorkspaceRepo(sql);

    // Determine variant from path
    const pathStr = filePath.replace(/\\/g, '/');
    let variant = 'stable';
    if (pathStr.includes('Code - Insiders')) variant = 'insiders';
    else if (pathStr.includes('Code - Exploration')) variant = 'exploration';
    else if (pathStr.includes('VSCodium')) variant = 'vscodium';

    const id = await repo.upsert(storageHash, variant);
    workspaceIdCache.set(storageHash, id);
    return id;
}

async function periodicScan(config: SnichConfig, log: vscode.LogOutputChannel): Promise<void> {
    if (isShuttingDown || !processor || !sql) return;

    const workspaces = discoverWorkspaces(config.watcher.watchVariants);
    let totalIngested = 0;

    for (const ws of workspaces) {
        const workspaceId = await ensureWorkspaceId(ws);
        const files = listChatFiles(ws.chatSessionsDir);

        for (const filePath of files) {
            try {
                const ingested = await processor.processFileChange(filePath, workspaceId);
                totalIngested += ingested;
            } catch (err) {
                log.error(`Periodic scan error for ${filePath}`, err);
            }
        }
    }

    if (totalIngested > 0) {
        log.debug(`Periodic scan: ingested ${totalIngested} events`);
    }
}

async function reconnect(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
    log.info('Reconnecting to database...');
    try {
        if (sql) await sql.end({ timeout: 2 });
    } catch { /* ignore */ }
    sql = null;
    workspaceIdCache.clear();

    try {
        await initializeSnich(context, log);
        vscode.window.showInformationMessage('Snich: Reconnected to database');
    } catch (err) {
        log.error('Reconnection failed', err);
        vscode.window.showErrorMessage('Snich: Reconnection failed. Check Output panel.');
    }
}

function showStatus(log: vscode.LogOutputChannel): void {
    const watchedDirs = watcher?.getWatchedDirectories() ?? [];
    const pending = localQueue?.getPendingCount() ?? 0;

    const msg = [
        `Snich Status`,
        `Instance: ${instanceId}`,
        `DB Connected: ${sql !== null}`,
        `Watched Dirs: ${watchedDirs.length}`,
        `Pending Events: ${pending}`,
        `Shutting Down: ${isShuttingDown}`,
    ].join('\n');

    log.info(msg);
    vscode.window.showInformationMessage(`Snich: DB=${sql !== null ? 'connected' : 'disconnected'}, Dirs=${watchedDirs.length}, Pending=${pending}`);
}

function scanNow(log: vscode.LogOutputChannel): void {
    const config = loadConfig(vscode.workspace);
    periodicScan(config, log).catch(err => log.error('Manual scan failed', err));
    vscode.window.showInformationMessage('Snich: Scan triggered');
}
