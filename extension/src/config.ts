import type { InkFlowConfig, VscodeVariant } from './types';

// Minimal vscode types for config reading — avoids importing vscode in tests
interface VscodeWorkspace {
    getConfiguration(section: string): {
        get<T>(key: string, defaultValue: T): T;
    };
}

export function loadConfig(workspace: VscodeWorkspace): InkFlowConfig {
    const db = workspace.getConfiguration('inkflow.database');
    const identity = workspace.getConfiguration('inkflow.identity');
    const watcher = workspace.getConfiguration('inkflow.watcher');
    const ingestion = workspace.getConfiguration('inkflow.ingestion');
    const privacy = workspace.getConfiguration('inkflow.privacy');
    const retention = workspace.getConfiguration('inkflow.retention');
    const exp = workspace.getConfiguration('inkflow.export');

    return {
        database: {
            host: db.get<string>('host', 'localhost'),
            port: db.get<number>('port', 5432),
            name: db.get<string>('name', 'inkflow'),
            user: db.get<string>('user', 'inkflow'),
            ssl: db.get<boolean>('ssl', false),
        },
        identity: {
            userId: identity.get<string>('userId', ''),
            displayName: identity.get<string>('displayName', ''),
        },
        watcher: {
            enabled: watcher.get<boolean>('enabled', true),
            debounceMs: watcher.get<number>('debounceMs', 300),
            watchVariants: watcher.get<VscodeVariant[]>('watchVariants', ['stable']),
            periodicScanSeconds: watcher.get<number>('periodicScanSeconds', 30),
        },
        ingestion: {
            filterInputState: ingestion.get<boolean>('filterInputState', true),
        },
        privacy: {
            redactContent: privacy.get<boolean>('redactContent', false),
        },
        retention: {
            maxAgeDays: retention.get<number | null>('maxAgeDays', null),
        },
        export: {
            defaultFormat: exp.get<'markdown' | 'html' | 'json'>('defaultFormat', 'markdown'),
            includeMetadata: exp.get<boolean>('includeMetadata', true),
            includeForks: exp.get<boolean>('includeForks', true),
            includeDeleted: exp.get<boolean>('includeDeleted', false),
        },
    };
}

/**
 * Build a database URL from config + password.
 * If INKFLOW_DATABASE_URL env var is set, use that instead.
 */
export function buildDatabaseUrl(config: InkFlowConfig['database'], password: string): string {
    const envUrl = process.env.INKFLOW_DATABASE_URL;
    if (envUrl) return envUrl;

    const protocol = config.ssl ? 'postgres' : 'postgres';
    const encodedPassword = encodeURIComponent(password);
    return `${protocol}://${config.user}:${encodedPassword}@${config.host}:${config.port}/${config.name}${config.ssl ? '?sslmode=require' : ''}`;
}
