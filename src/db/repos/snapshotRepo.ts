import postgres from 'postgres';
import type { SnapshotTrigger } from '../../types';

export class SnapshotRepo {
    constructor(private sql: postgres.Sql) { }

    async create(
        sessionId: number,
        snapshotHash: Buffer,
        fullState: unknown,
        messageCount: number,
        trigger: SnapshotTrigger,
    ): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO session_snapshots (session_id, snapshot_hash, full_state, message_count, trigger)
            VALUES (${sessionId}, ${snapshotHash}, ${JSON.stringify(fullState)}, ${messageCount}, ${trigger})
            RETURNING id
        `;
        return row.id;
    }

    async getBySession(sessionId: number) {
        return await this.sql`
            SELECT * FROM session_snapshots
            WHERE session_id = ${sessionId}
            ORDER BY created_at DESC
        `;
    }
}
