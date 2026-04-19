#!/usr/bin/env node
/**
 * backfill-turns.js
 *
 * Standalone backfill script: reads raw_events from the InkFlow DB,
 * replays the JSONL state per session, and populates the turns + turn_parts tables.
 *
 * Run once after migration 002 to materialise existing data.
 *
 * Usage:
 *   node scripts/backfill-turns.js
 */
'use strict';

const { Client } = require('pg');

// ── Minimal JSONL replayer (mirrors src/parser/jsonlReplayer.ts) ──
function applyPatch(state, entry) {
    if (entry.kind === 0) return JSON.parse(JSON.stringify(entry.v));
    const path = entry.k;
    if (!path || path.length === 0) return state;
    let cur = state;
    for (let i = 0; i < path.length - 1; i++) {
        if (cur[path[i]] === undefined || cur[path[i]] === null) cur[path[i]] = {};
        cur = cur[path[i]];
    }
    const last = path[path.length - 1];
    if (entry.kind === 1) {
        cur[last] = entry.v;
    } else if (entry.kind === 2) {
        if (!Array.isArray(cur[last])) cur[last] = [];
        if (entry.i !== undefined) cur[last].length = entry.i;
        if (Array.isArray(entry.v)) cur[last].push(...entry.v);
    } else if (entry.kind === 3) {
        delete cur[last];
    }
    return state;
}

// ── Parse response parts (mirrors eventProcessor.ts parseResponseParts) ──
function parseResponseParts(response) {
    if (!response || !Array.isArray(response)) return [];
    return response.map((part, idx) => {
        const kind = part?.kind ?? null;
        let content = null;
        if (kind === null && typeof part?.value === 'string') {
            content = part.value;
        } else if (kind === 'thinking' && typeof part?.value === 'string') {
            content = part.value;
        } else if (kind === 'toolInvocationSerialized') {
            const msg = part?.invocationMessage?.value || part?.pastTenseMessage?.value;
            content = typeof msg === 'string' ? msg : null;
        } else if (kind === 'textEditGroup') {
            const uri = part?.uri?.fsPath || part?.uri?.path;
            content = typeof uri === 'string' ? uri : null;
        } else if (kind === 'inlineReference') {
            const name = part?.inlineReference?.name || part?.inlineReference?.uri?.fsPath;
            content = typeof name === 'string' ? name : null;
        } else if (kind === 'codeblockUri') {
            const uri = part?.uri?.fsPath || part?.uri?.path;
            content = typeof uri === 'string' ? uri : null;
        }
        return { partIndex: idx, kind, content, rawJson: part };
    });
}

async function backfillSession(client, session, events) {
    // Replay all events
    let state = null;
    for (const event of events) {
        const entry = typeof event.raw_content === 'string'
            ? JSON.parse(event.raw_content)
            : event.raw_content;
        state = applyPatch(state, entry);
    }

    if (!state?.requests || !Array.isArray(state.requests)) return 0;

    const sessionId = session.id;
    const rawEventId = events[events.length - 1].id;
    let turnsWritten = 0;

    for (let i = 0; i < state.requests.length; i++) {
        const req = state.requests[i];
        const userText = req?.message?.text || req?.message?.content || '';
        const modelId = req?.modelId || state?.modelId || null;
        const agentId = req?.agent?.id || null;
        const mode = req?.agent?.modes?.[0] || null;
        const tsMs = typeof req?.timestamp === 'number' ? req.timestamp : null;
        const doneMs = typeof req?.modelState?.completedAt === 'number' ? req.modelState.completedAt : null;

        // Upsert turn
        const turnRes = await client.query(`
            INSERT INTO turns (
                session_id, turn_index, request_id, response_id,
                timestamp_ms, completed_at_ms, model_id, agent_id,
                mode, user_text, user_raw, is_fork, fork_source_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,NULL)
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
                deleted_at      = NULL
            RETURNING id
        `, [
            sessionId, i,
            req?.requestId ?? null, req?.responseId ?? null,
            tsMs, doneMs, modelId, agentId, mode,
            userText,
            req?.message ? JSON.stringify(req.message) : null,
        ]);
        const turnId = turnRes.rows[0].id;

        // Parse parts
        const parts = parseResponseParts(req?.response);

        if (parts.length > 0) {
            for (const part of parts) {
                await client.query(`
                    INSERT INTO turn_parts (turn_id, part_index, kind, content, raw_json)
                    VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (turn_id, part_index) DO UPDATE SET
                        kind     = EXCLUDED.kind,
                        content  = EXCLUDED.content,
                        raw_json = EXCLUDED.raw_json
                `, [turnId, part.partIndex, part.kind, part.content, JSON.stringify(part.rawJson)]);
            }

            // Remove stale parts beyond current count
            await client.query(`
                DELETE FROM turn_parts WHERE turn_id = $1 AND part_index >= $2
            `, [turnId, parts.length]);
        }

        turnsWritten++;
    }

    // Advance cursor
    await client.query(`
        UPDATE sessions SET last_event_id = $1, last_modified_at = NOW()
        WHERE id = $2
    `, [rawEventId, sessionId]);

    return turnsWritten;
}

async function main() {
    const client = new Client(
        process.env.INKFLOW_DATABASE_URL
            ? { connectionString: process.env.INKFLOW_DATABASE_URL }
            : {
                host: process.env.PGHOST || 'localhost',
                port: parseInt(process.env.PGPORT || '5434'),
                database: process.env.PGDATABASE || 'inkflow',
                user: process.env.PGUSER || 'inkflow',
                password: process.env.PGPASSWORD || 'inkflow_dev',
            }
    );

    await client.connect();
    console.log('Connected to InkFlow DB');

    try {
        // Get all sessions that need backfilling (last_event_id IS NULL means reset)
        const sessionsRes = await client.query(`
            SELECT id, session_uuid, source_file
            FROM sessions
            WHERE deleted_at IS NULL
              AND last_event_id IS NULL
            ORDER BY id ASC
        `);

        console.log(`Found ${sessionsRes.rows.length} sessions to backfill`);

        let totalTurns = 0;
        let processed = 0;
        let skipped = 0;

        for (const session of sessionsRes.rows) {
            // Get all raw events for this session file
            const eventsRes = await client.query(`
                SELECT id, kind, raw_content
                FROM raw_events
                WHERE session_file = $1
                ORDER BY id ASC
            `, [session.source_file]);

            if (eventsRes.rows.length === 0) {
                skipped++;
                continue;
            }

            try {
                const turns = await backfillSession(client, session, eventsRes.rows);
                totalTurns += turns;
                processed++;

                if (processed % 50 === 0) {
                    process.stdout.write(`\rProcessed ${processed}/${sessionsRes.rows.length} sessions, ${totalTurns} turns...`);
                }
            } catch (err) {
                console.error(`\nError backfilling session ${session.session_uuid}:`, err.message);
                skipped++;
            }
        }

        console.log(`\n\nBackfill complete!`);
        console.log(`  Sessions processed : ${processed}`);
        console.log(`  Sessions skipped   : ${skipped}`);
        console.log(`  Total turns written: ${totalTurns}`);

        // Final stats
        const statsRes = await client.query(`
            SELECT
                COUNT(DISTINCT t.id) AS total_turns,
                COUNT(tp.id) AS total_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind IS NULL) AS text_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'thinking') AS thinking_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'toolInvocationSerialized') AS tool_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'textEditGroup') AS edit_parts
            FROM turns t
            LEFT JOIN turn_parts tp ON tp.turn_id = t.id
            WHERE t.deleted_at IS NULL
        `);
        const s = statsRes.rows[0];
        console.log('\nDB Summary:');
        console.log(`  Total turns    : ${s.total_turns}`);
        console.log(`  Total parts    : ${s.total_parts}`);
        console.log(`  Text chunks    : ${s.text_parts}`);
        console.log(`  Thinking steps : ${s.thinking_parts}`);
        console.log(`  Tool calls     : ${s.tool_parts}`);
        console.log(`  File edits     : ${s.edit_parts}`);
    } finally {
        await client.end();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
