import { Router } from 'express';
import type { Pool } from 'pg';

export const searchRouter = Router();

/** GET /api/search — full-text search across sessions and turns */
searchRouter.get('/', async (req, res) => {
    const pool: Pool = (req as any).pool;
    const {
        q = '',
        user_id,
        workspace_id,
        model_id,
        agent_id,
        kind,
        date_from,
        date_to,
        has_tool_calls,
        has_thinking,
        has_file_edits,
        min_turns,
        max_turns,
        limit = '50',
        offset = '0',
    } = req.query as Record<string, string>;

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    try {
        const conditions: string[] = ['s.deleted_at IS NULL', 't.deleted_at IS NULL'];
        const params: any[] = [];
        let paramIdx = 1;

        if (q) {
            conditions.push(`(
        t.user_text ILIKE $${paramIdx} OR
        tp.content ILIKE $${paramIdx} OR
        s.title ILIKE $${paramIdx} OR
        s.custom_title ILIKE $${paramIdx}
      )`);
            params.push(`%${q}%`);
            paramIdx++;
        }

        if (user_id) {
            conditions.push(`s.user_id = $${paramIdx++}`);
            params.push(parseInt(user_id));
        }

        if (workspace_id) {
            conditions.push(`s.workspace_id = $${paramIdx++}`);
            params.push(parseInt(workspace_id));
        }

        if (model_id) {
            conditions.push(`t.model_id ILIKE $${paramIdx++}`);
            params.push(`%${model_id}%`);
        }

        if (agent_id) {
            conditions.push(`t.agent_id ILIKE $${paramIdx++}`);
            params.push(`%${agent_id}%`);
        }

        if (kind) {
            conditions.push(`tp.kind = $${paramIdx++}`);
            params.push(kind);
        }

        if (date_from) {
            conditions.push(`s.last_modified_at >= $${paramIdx++}::timestamptz`);
            params.push(date_from);
        }

        if (date_to) {
            conditions.push(`s.last_modified_at <= $${paramIdx++}::timestamptz`);
            params.push(date_to);
        }

        const where = conditions.join(' AND ');

        // Search returns matching turns with session context
        const result = await pool.query(
            `SELECT DISTINCT ON (s.id, t.turn_index)
              s.id AS session_id, s.session_uuid, s.title, s.custom_title,
              s.last_modified_at,
              w.folder_uri, w.display_name AS workspace_name,
              u.user_uid, u.display_name AS user_display_name,
              t.id AS turn_id, t.turn_index, t.user_text, t.model_id,
              t.timestamp_ms,
              tp.kind AS matched_kind, LEFT(tp.content, 200) AS matched_content
       FROM sessions s
       JOIN turns t ON t.session_id = s.id
       LEFT JOIN turn_parts tp ON tp.turn_id = t.id
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where}
       ORDER BY s.id, t.turn_index, s.last_modified_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, lim, off],
        );

        // Count total matches
        const countResult = await pool.query(
            `SELECT COUNT(DISTINCT (s.id, t.id)) AS total
       FROM sessions s
       JOIN turns t ON t.session_id = s.id
       LEFT JOIN turn_parts tp ON tp.turn_id = t.id
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where}`,
            params,
        );

        res.json({
            results: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit: lim,
            offset: off,
        });
    } catch (err: any) {
        console.error('Search error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/search/filters — available filter values */
searchRouter.get('/filters', async (req, res) => {
    const pool: Pool = (req as any).pool;

    try {
        const [workspaces, models, agents, kinds, users] = await Promise.all([
            pool.query(
                `SELECT DISTINCT w.id, w.folder_uri, w.display_name, w.variant
         FROM workspaces w
         JOIN sessions s ON s.workspace_id = w.id AND s.deleted_at IS NULL
         ORDER BY w.display_name`
            ),
            pool.query(
                `SELECT DISTINCT model_id, COUNT(*) AS count
         FROM turns WHERE model_id IS NOT NULL AND deleted_at IS NULL
         GROUP BY model_id ORDER BY count DESC`
            ),
            pool.query(
                `SELECT DISTINCT agent_id, COUNT(*) AS count
         FROM turns WHERE agent_id IS NOT NULL AND deleted_at IS NULL
         GROUP BY agent_id ORDER BY count DESC`
            ),
            pool.query(
                `SELECT kind, COUNT(*) AS count
         FROM turn_parts
         GROUP BY kind ORDER BY count DESC`
            ),
            pool.query(
                `SELECT u.id, u.user_uid, u.display_name,
                COUNT(DISTINCT s.id) AS session_count
         FROM users u
         LEFT JOIN sessions s ON s.user_id = u.id AND s.deleted_at IS NULL
         GROUP BY u.id
         ORDER BY u.display_name, u.user_uid`
            ),
        ]);

        res.json({
            workspaces: workspaces.rows,
            models: models.rows,
            agents: agents.rows,
            kinds: kinds.rows,
            users: users.rows,
        });
    } catch (err: any) {
        console.error('Filters error:', err);
        res.status(500).json({ error: err.message });
    }
});
