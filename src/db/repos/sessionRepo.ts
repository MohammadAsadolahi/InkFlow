import postgres from 'postgres';

export class SessionRepo {
    constructor(private sql: postgres.Sql) { }

    async upsertFromInitial(
        sessionUuid: string,
        workspaceId: number,
        sourceFile: string,
        title?: string,
        createdAt?: Date,
    ): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO sessions (session_uuid, workspace_id, source_file, title, created_at)
            VALUES (${sessionUuid}, ${workspaceId}, ${sourceFile}, ${title ?? null}, ${createdAt ?? null})
            ON CONFLICT (session_uuid) DO UPDATE SET
                last_modified_at = NOW(),
                source_file = EXCLUDED.source_file
            RETURNING id
        `;
        return row.id;
    }

    async getByUuid(sessionUuid: string) {
        const [row] = await this.sql`
            SELECT * FROM sessions WHERE session_uuid = ${sessionUuid}
        `;
        return row ?? null;
    }

    async updateCursor(sessionUuid: string, lastEventId: number): Promise<void> {
        await this.sql`
            UPDATE sessions
            SET last_event_id = ${lastEventId}, last_modified_at = NOW()
            WHERE session_uuid = ${sessionUuid}
        `;
    }

    async updateTitle(sessionUuid: string, title: string): Promise<void> {
        await this.sql`
            UPDATE sessions
            SET title = ${title}, last_modified_at = NOW()
            WHERE session_uuid = ${sessionUuid}
        `;
    }

    async updateCustomTitle(sessionUuid: string, customTitle: string): Promise<void> {
        await this.sql`
            UPDATE sessions
            SET custom_title = ${customTitle}, last_modified_at = NOW()
            WHERE session_uuid = ${sessionUuid}
        `;
    }

    async updateTurnCount(sessionUuid: string, turnCount: number): Promise<void> {
        await this.sql`
            UPDATE sessions
            SET turn_count = ${turnCount}, last_modified_at = NOW()
            WHERE session_uuid = ${sessionUuid}
        `;
    }

    async incrementForkCount(sessionUuid: string): Promise<void> {
        await this.sql`
            UPDATE sessions
            SET fork_count = fork_count + 1, version = version + 1, last_modified_at = NOW()
            WHERE session_uuid = ${sessionUuid}
        `;
    }

    async listActive(workspaceId?: number, limit = 50, offset = 0) {
        if (workspaceId !== undefined) {
            return await this.sql`
                SELECT * FROM sessions
                WHERE deleted_at IS NULL AND workspace_id = ${workspaceId}
                ORDER BY last_modified_at DESC
                LIMIT ${limit} OFFSET ${offset}
            `;
        }
        return await this.sql`
            SELECT * FROM sessions
            WHERE deleted_at IS NULL
            ORDER BY last_modified_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `;
    }
}
