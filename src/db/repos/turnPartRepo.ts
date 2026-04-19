import type postgres from 'postgres';

export interface TurnPartInput {
    turnId: number;
    partIndex: number;
    kind: string | null;
    content: string | null;
    rawJson: unknown;
}

export class TurnPartRepo {
    constructor(private sql: postgres.TransactionSql | postgres.Sql) { }

    /**
     * Insert or replace all parts for a turn.
     * Deletes parts beyond the new count so shrinking responses are handled.
     */
    async replaceAll(turnId: number, parts: Omit<TurnPartInput, 'turnId'>[]): Promise<void> {
        if (parts.length === 0) return;

        // Upsert each part
        for (const part of parts) {
            await this.sql`
                INSERT INTO turn_parts (turn_id, part_index, kind, content, raw_json)
                VALUES (
                    ${turnId},
                    ${part.partIndex},
                    ${part.kind},
                    ${part.content},
                    ${JSON.stringify(part.rawJson)}
                )
                ON CONFLICT (turn_id, part_index) DO UPDATE SET
                    kind     = EXCLUDED.kind,
                    content  = EXCLUDED.content,
                    raw_json = EXCLUDED.raw_json
            `;
        }

        // Delete any parts beyond the new count (handles shrinking)
        await this.sql`
            DELETE FROM turn_parts
            WHERE turn_id = ${turnId} AND part_index >= ${parts.length}
        `;
    }

    async deleteByTurnIds(turnIds: number[]): Promise<void> {
        if (turnIds.length === 0) return;
        await this.sql`DELETE FROM turn_parts WHERE turn_id = ANY(${turnIds})`;
    }
}
