import type { SnichConfig, VscodeVariant } from './types';

// Minimal vscode types for config reading — avoids importing vscode in tests
interface VscodeWorkspace {
    getConfiguration(section: string): {
        get<T>(key: string, defaultValue: T): T;
    };
}

export function loadConfig(workspace: VscodeWorkspace): SnichConfig {
    const db = workspace.getConfiguration('snich.database');
    const watcher = workspace.getConfiguration('snich.watcher');
    const ingestion = workspace.getConfiguration('snich.ingestion');
    const privacy = workspace.getConfiguration('snich.privacy');
    const retention = workspace.getConfiguration('snich.retention');
    const exp = workspace.getConfiguration('snich.export');

    return {
        database: {
            host: db.get<string>('host', 'localhost'),
            port: db.get<number>('port', 5432),
            name: db.get<string>('name', 'snich'),
            user: db.get<string>('user', 'snich'),
            ssl: db.get<boolean>('ssl', false),
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
 * If SNICH_DATABASE_URL env var is set, use that instead.
 */
export function buildDatabaseUrl(config: SnichConfig['database'], password: string): string {
    const envUrl = process.env.SNICH_DATABASE_URL;
    if (envUrl) return envUrl;

    const protocol = config.ssl ? 'postgres' : 'postgres';
    const encodedPassword = encodeURIComponent(password);
    return `${protocol}://${config.user}:${encodedPassword}@${config.host}:${config.port}/${config.name}${config.ssl ? '?sslmode=require' : ''}`;
}
