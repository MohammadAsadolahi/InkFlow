import { Router } from 'express';
import type { Pool } from 'pg';

export const turnsRouter = Router();

/** GET /api/turns?session_id=X — all turns + parts for a session */
turnsRouter.get('/', async (req, res) => {
    const pool: Pool = (req as any).pool;
    const { session_id, session_uuid } = req.query as Record<string, string>;

    if (!session_id && !session_uuid) {
        return res.status(400).json({ error: 'session_id or session_uuid required' });
    }

    try {
        let sessionIdNum: number;

        if (session_uuid) {
            const s = await pool.query(
                'SELECT id FROM sessions WHERE session_uuid = $1 AND deleted_at IS NULL',
                [session_uuid],
            );
            if (s.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
            sessionIdNum = s.rows[0].id;
        } else {
            sessionIdNum = parseInt(session_id!);
        }

        const turnsResult = await pool.query(
            `SELECT t.id, t.turn_index, t.request_id, t.response_id,
              t.timestamp_ms, t.completed_at_ms, t.model_id, t.agent_id,
              t.mode, t.user_text, t.is_fork
       FROM turns t
       WHERE t.session_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.turn_index ASC`,
            [sessionIdNum],
        );

        // Load all parts in one query for efficiency
        const partsResult = await pool.query(
            `SELECT tp.turn_id, tp.part_index, tp.kind, tp.content, tp.raw_json
       FROM turn_parts tp
       JOIN turns t ON tp.turn_id = t.id
       WHERE t.session_id = $1 AND t.deleted_at IS NULL
       ORDER BY tp.turn_id, tp.part_index ASC`,
            [sessionIdNum],
        );

        // Group parts by turn_id
        const partsByTurn = new Map<number, any[]>();
        for (const p of partsResult.rows) {
            const arr = partsByTurn.get(p.turn_id) || [];
            arr.push({
                partIndex: p.part_index,
                kind: p.kind,
                content: p.content,
                rawJson: p.raw_json,
            });
            partsByTurn.set(p.turn_id, arr);
        }

        const turns = turnsResult.rows.map((t) => ({
            ...t,
            parts: partsByTurn.get(t.id) || [],
        }));

        res.json({ turns, sessionId: sessionIdNum });
    } catch (err: any) {
        console.error('Turns list error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/turns/:turnId/parts — parts for one turn */
turnsRouter.get('/:turnId/parts', async (req, res) => {
    const pool: Pool = (req as any).pool;
    const turnId = parseInt(req.params.turnId);

    try {
        const result = await pool.query(
            `SELECT part_index, kind, content, raw_json
       FROM turn_parts
       WHERE turn_id = $1
       ORDER BY part_index ASC`,
            [turnId],
        );

        res.json({ parts: result.rows });
    } catch (err: any) {
        console.error('Parts list error:', err);
        res.status(500).json({ error: err.message });
    }
});
