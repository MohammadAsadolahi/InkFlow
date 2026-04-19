import { Router } from 'express';
import type { Pool } from 'pg';

export const usersRouter = Router();

/** GET /api/users — list all users */
usersRouter.get('/', async (req, res) => {
    const pool: Pool = (req as any).pool;

    try {
        const result = await pool.query(
            `SELECT u.id, u.user_uid, u.display_name, u.machine_id,
              u.first_seen_at, u.last_seen_at,
              COUNT(DISTINCT s.id) AS session_count,
              COUNT(DISTINCT t.id) AS turn_count
       FROM users u
       LEFT JOIN sessions s ON s.user_id = u.id AND s.deleted_at IS NULL
       LEFT JOIN turns t ON t.user_id = u.id AND t.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.last_seen_at DESC`,
        );

        res.json({ users: result.rows });
    } catch (err: any) {
        console.error('Users list error:', err);
        res.status(500).json({ error: err.message });
    }
});
