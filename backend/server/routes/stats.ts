import { Router } from 'express';
import type { Pool } from 'pg';

export const statsRouter = Router();

/** GET /api/stats — dashboard overview statistics */
statsRouter.get('/', async (req, res) => {
    const pool: Pool = (req as any).pool;

    try {
        const [overview, kindStats, recentActivity, topWorkspaces] = await Promise.all([
            pool.query(`
        SELECT
          (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL) AS total_sessions,
          (SELECT COUNT(*) FROM turns WHERE deleted_at IS NULL) AS total_turns,
          (SELECT COUNT(*) FROM turn_parts) AS total_parts,
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(DISTINCT workspace_id) FROM sessions WHERE deleted_at IS NULL) AS total_workspaces,
          (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL
            AND last_modified_at > NOW() - INTERVAL '24 hours') AS sessions_24h,
          (SELECT COUNT(*) FROM turns WHERE deleted_at IS NULL
            AND timestamp_ms > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000) AS turns_24h
      `),
            pool.query(`
        SELECT kind, COUNT(*) AS count
        FROM turn_parts GROUP BY kind ORDER BY count DESC
      `),
            pool.query(`
        SELECT DATE(s.last_modified_at) AS day, COUNT(DISTINCT s.id) AS sessions, COUNT(t.id) AS turns
        FROM sessions s
        LEFT JOIN turns t ON t.session_id = s.id AND t.deleted_at IS NULL
        WHERE s.deleted_at IS NULL AND s.last_modified_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(s.last_modified_at)
        ORDER BY day DESC
        LIMIT 30
      `),
            pool.query(`
        SELECT w.id, w.folder_uri, w.display_name, w.variant,
               COUNT(DISTINCT s.id) AS sessions,
               COUNT(DISTINCT t.id) AS turns
        FROM workspaces w
        JOIN sessions s ON s.workspace_id = w.id AND s.deleted_at IS NULL
        LEFT JOIN turns t ON t.session_id = s.id AND t.deleted_at IS NULL
        GROUP BY w.id
        ORDER BY sessions DESC
        LIMIT 10
      `),
        ]);

        res.json({
            overview: overview.rows[0],
            kindStats: kindStats.rows,
            recentActivity: recentActivity.rows,
            topWorkspaces: topWorkspaces.rows,
        });
    } catch (err: any) {
        console.error('Stats error:', err);
        res.status(500).json({ error: err.message });
    }
});
