import postgres from 'postgres';
import type { RawEventInput } from '../../types';

export class RawEventRepo {
    constructor(private sql: postgres.Sql) { }

    /**
     * Insert a raw event, deduplicating by event_hash.
     * Returns the event ID if inserted, null if duplicate.
     */
    async insert(event: RawEventInput): Promise<number | null> {
        const result = await this.sql`
            INSERT INTO raw_events (
                event_hash, workspace_id, session_file, byte_offset,
                kind, key_path, raw_content, file_mtime_ms,
                instance_id, batch_id
            ) VALUES (
                ${event.eventHash}, ${event.workspaceId}, ${event.sessionFile}, ${event.byteOffset},
                ${event.kind}, ${event.keyPath ? this.sql.array(event.keyPath) : null},
                ${JSON.stringify(event.rawContent)}, ${event.fileMtimeMs},
                ${event.instanceId}, ${event.batchId}
            )
            ON CONFLICT (event_hash) DO NOTHING
            RETURNING id
        `;
        return result.length > 0 ? result[0].id : null;
    }

    /**
     * Get unmaterialized events for a session file after a cursor.
     */
    async getAfterCursor(sessionFile: string, lastEventId: number): Promise<postgres.Row[]> {
        return await this.sql`
            SELECT * FROM raw_events
            WHERE session_file = ${sessionFile} AND id > ${lastEventId}
            ORDER BY id ASC
        `;
    }
}
