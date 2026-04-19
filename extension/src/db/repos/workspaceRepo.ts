import postgres from 'postgres';

export class WorkspaceRepo {
    constructor(private sql: postgres.Sql) { }

    async upsert(storageHash: string, variant: string, folderUri?: string, displayName?: string): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO workspaces (storage_hash, variant, folder_uri, display_name)
            VALUES (${storageHash}, ${variant}, ${folderUri ?? null}, ${displayName ?? null})
            ON CONFLICT (storage_hash) DO UPDATE SET
                last_seen_at = NOW(),
                folder_uri = COALESCE(EXCLUDED.folder_uri, workspaces.folder_uri),
                display_name = COALESCE(EXCLUDED.display_name, workspaces.display_name)
            RETURNING id
        `;
        return row.id;
    }

    async getByHash(storageHash: string) {
        const [row] = await this.sql`
            SELECT * FROM workspaces WHERE storage_hash = ${storageHash}
        `;
        return row ?? null;
    }
}
