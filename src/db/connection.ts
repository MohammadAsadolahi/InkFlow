import postgres from 'postgres';
import type { SnichConfig } from '../types';

export interface ConnectionOptions {
    config: SnichConfig['database'];
    password: string;
    onNotice?: (notice: postgres.Notice) => void;
}

/**
 * Create a postgres connection pool.
 * Uses porsager/postgres: pure JS, zero native modules, tagged template literals (SQL injection safe).
 */
export function createPool(opts: ConnectionOptions): postgres.Sql {
    const { config, password, onNotice } = opts;

    const envUrl = process.env.SNICH_DATABASE_URL;

    if (envUrl) {
        return postgres(envUrl, {
            max: 3,
            idle_timeout: 30,
            connect_timeout: 5,
            max_lifetime: 1800,
            onnotice: onNotice,
        });
    }

    return postgres({
        host: config.host,
        port: config.port,
        database: config.name,
        username: config.user,
        password: password,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: 3,
        idle_timeout: 30,
        connect_timeout: 5,
        max_lifetime: 1800,
        onnotice: onNotice,
    });
}

/**
 * Health check: run a simple query to verify the connection is alive.
 */
export async function healthCheck(sql: postgres.Sql): Promise<boolean> {
    try {
        const result = await sql`SELECT 1 AS ok`;
        return result.length === 1 && result[0].ok === 1;
    } catch {
        return false;
    }
}
