import type postgres from 'postgres';

export interface TurnUpsertInput {
    sessionId: number;
    turnIndex: number;
    requestId?: string | null;
    responseId?: string | null;
    timestampMs?: number | null;
    completedAtMs?: number | null;
    modelId?: string | null;
    agentId?: string | null;
    mode?: string | null;
    userText: string;
    userRaw?: unknown;
    isFork?: boolean;
    forkSourceId?: number | null;
}

export class TurnRepo {
    constructor(private sql: postgres.TransactionSql | postgres.Sql) { }

    /**
     * Insert or update a turn. On conflict (session_id, turn_index) we update all
     * mutable fields so re-runs after a file-rewrite converge to the latest state.
     */
    async upsert(input: TurnUpsertInput): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO turns (
                session_id, turn_index, request_id, response_id,
                timestamp_ms, completed_at_ms, model_id, agent_id,
                mode, user_text, user_raw, is_fork, fork_source_id
            ) VALUES (
                ${input.sessionId},
                ${input.turnIndex},
                ${input.requestId ?? null},
                ${input.responseId ?? null},
                ${input.timestampMs ?? null},
                ${input.completedAtMs ?? null},
                ${input.modelId ?? null},
                ${input.agentId ?? null},
                ${input.mode ?? null},
                ${input.userText},
                ${input.userRaw ? JSON.stringify(input.userRaw) : null},
                ${input.isFork ?? false},
                ${input.forkSourceId ?? null}
            )
            ON CONFLICT (session_id, turn_index) DO UPDATE SET
                request_id      = EXCLUDED.request_id,
                response_id     = EXCLUDED.response_id,
                timestamp_ms    = EXCLUDED.timestamp_ms,
                completed_at_ms = EXCLUDED.completed_at_ms,
                model_id        = EXCLUDED.model_id,
                agent_id        = EXCLUDED.agent_id,
                mode            = EXCLUDED.mode,
                user_text       = EXCLUDED.user_text,
                user_raw        = EXCLUDED.user_raw,
                is_fork         = EXCLUDED.is_fork,
                fork_source_id  = EXCLUDED.fork_source_id,
                deleted_at      = NULL
            RETURNING id
        `;
        return row.id;
    }

    async softDeleteFrom(sessionId: number, fromTurnIndex: number): Promise<void> {
        await this.sql`
            UPDATE turns
            SET deleted_at = NOW()
            WHERE session_id = ${sessionId}
              AND turn_index >= ${fromTurnIndex}
              AND deleted_at IS NULL
        `;
    }
}
