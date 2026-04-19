import { Router } from 'express';
import type { Pool } from 'pg';

export const sessionsRouter = Router();

/** GET /api/sessions — list sessions with pagination & filters */
sessionsRouter.get('/', async (req, res) => {
    const pool: Pool = (req as any).pool;
    const {
        limit = '50',
        offset = '0',
        user_id,
        workspace_id,
        search,
        sort = 'last_modified_at',
        order = 'desc',
        date_from,
        date_to,
    } = req.query as Record<string, string>;

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;
    const sortMap: Record<string, string> = {
        last_modified_at: 's.last_modified_at',
        created_at: 's.created_at',
        turn_count: 's.turn_count',
        title: 's.title',
    };
    const sortExpr = sortMap[sort] || 's.last_modified_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    const conditions: string[] = ['s.deleted_at IS NULL'];
    const params: any[] = [];
    let paramIdx = 1;

    if (user_id) {
        conditions.push(`s.user_id = $${paramIdx++}`);
        params.push(parseInt(user_id));
    }
    if (workspace_id) {
        conditions.push(`s.workspace_id = $${paramIdx++}`);
        params.push(parseInt(workspace_id));
    }
    if (search) {
        conditions.push(`(
      s.title ILIKE $${paramIdx} OR
      s.custom_title ILIKE $${paramIdx} OR
      s.session_uuid ILIKE $${paramIdx} OR
      u.user_uid ILIKE $${paramIdx} OR
      u.display_name ILIKE $${paramIdx}
    )`);
        params.push(`%${search}%`);
        paramIdx++;
    }
    if (date_from) {
        conditions.push(`s.last_modified_at >= $${paramIdx++}::timestamptz`);
        params.push(date_from);
    }
    if (date_to) {
        conditions.push(`s.last_modified_at <= $${paramIdx++}::timestamptz`);
        params.push(date_to + 'T23:59:59Z');
    }

    const where = conditions.join(' AND ');

    try {
        const countResult = await pool.query(
            `SELECT COUNT(*) FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where}`,
            params,
        );

        const result = await pool.query(
            `SELECT s.id, s.session_uuid, s.title, s.custom_title,
              s.model_info, s.turn_count, s.fork_count,
              s.created_at, s.last_modified_at, s.source_file,
              s.user_id, s.workspace_id,
              w.folder_uri, w.display_name AS workspace_name, w.variant,
              u.user_uid, u.display_name AS user_display_name,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.deleted_at IS NULL) AS actual_turns,
              (SELECT COUNT(*) FROM turn_parts tp
               JOIN turns t ON tp.turn_id = t.id
               WHERE t.session_id = s.id AND t.deleted_at IS NULL) AS total_parts
       FROM sessions s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE ${where}
       ORDER BY ${sortExpr} ${sortDir}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, lim, off],
        );

        res.json({
            sessions: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit: lim,
            offset: off,
        });
    } catch (err: any) {
        console.error('Sessions list error:', err);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/sessions/:id — single session with full details */
sessionsRouter.get('/:id', async (req, res) => {
    const pool: Pool = (req as any).pool;
    const { id } = req.params;

    try {
        const isUuid = id.includes('-');
        const sessionQuery = isUuid
            ? `SELECT s.*, w.folder_uri, w.display_name AS workspace_name, w.variant,
                u.user_uid, u.display_name AS user_display_name
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.session_uuid = $1 AND s.deleted_at IS NULL`
            : `SELECT s.*, w.folder_uri, w.display_name AS workspace_name, w.variant,
                u.user_uid, u.display_name AS user_display_name
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         LEFT JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.deleted_at IS NULL`;

        const result = await pool.query(sessionQuery, [isUuid ? id : parseInt(id)]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Get part kind stats
        const statsResult = await pool.query(
            `SELECT tp.kind, COUNT(*) AS count
       FROM turn_parts tp
       JOIN turns t ON tp.turn_id = t.id
       WHERE t.session_id = $1 AND t.deleted_at IS NULL
       GROUP BY tp.kind
       ORDER BY count DESC`,
            [result.rows[0].id],
        );

        res.json({
            session: result.rows[0],
            partStats: statsResult.rows,
        });
    } catch (err: any) {
        console.error('Session detail error:', err);
        res.status(500).json({ error: err.message });
    }
});
