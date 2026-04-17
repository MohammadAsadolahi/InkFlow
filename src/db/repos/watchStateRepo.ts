import postgres from 'postgres';

export class WatchStateRepo {
    constructor(private sql: postgres.Sql) { }

    async get(filePath: string) {
        const [row] = await this.sql`
            SELECT * FROM watch_state WHERE file_path = ${filePath}
        `;
        return row ?? null;
    }

    async upsert(
        filePath: string,
        lastByteOffset: number,
        headerHash: Buffer | null,
        workspaceId?: number,
        lastFileSize?: number,
        lastMtimeMs?: number,
    ): Promise<void> {
        await this.sql`
            INSERT INTO watch_state (file_path, last_byte_offset, header_hash, workspace_id, last_file_size, last_mtime_ms, processed_at)
            VALUES (${filePath}, ${lastByteOffset}, ${headerHash}, ${workspaceId ?? null}, ${lastFileSize ?? 0}, ${lastMtimeMs ?? null}, NOW())
            ON CONFLICT (file_path) DO UPDATE SET
                last_byte_offset = ${lastByteOffset},
                header_hash = ${headerHash},
                last_file_size = COALESCE(${lastFileSize ?? null}, watch_state.last_file_size),
                last_mtime_ms = COALESCE(${lastMtimeMs ?? null}, watch_state.last_mtime_ms),
                processed_at = NOW()
        `;
    }

    async resetOffset(filePath: string): Promise<void> {
        await this.sql`
            UPDATE watch_state
            SET last_byte_offset = 0, processed_at = NOW()
            WHERE file_path = ${filePath}
        `;
    }
}
