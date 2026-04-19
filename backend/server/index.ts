import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { sessionsRouter } from './routes/sessions.js';
import { turnsRouter } from './routes/turns.js';
import { usersRouter } from './routes/users.js';
import { searchRouter } from './routes/search.js';
import { statsRouter } from './routes/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = parseInt(process.env.PORT || '3700', 10);

// Database pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://inkflow:inkflow_dev@localhost:5434/inkflow',
    max: 10,
    idleTimeoutMillis: 30000,
});

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json());

// Inject pool into request
app.use((req, _res, next) => {
    (req as any).pool = pool;
    next();
});

// API routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/turns', turnsRouter);
app.use('/api/users', usersRouter);
app.use('/api/search', searchRouter);
app.use('/api/stats', statsRouter);

// Serve static frontend in production
const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
    console.log(`InkFlow API server listening on http://0.0.0.0:${port}`);
});

export { app, pool };
