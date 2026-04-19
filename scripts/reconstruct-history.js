#!/usr/bin/env node
/**
 * reconstruct-history.js
 *
 * Reads a session from the InkFlow DB and prints the full conversation
 * history including: user messages, agent thinking, tool calls, file edits,
 * and AI text — in the exact order they appeared.
 *
 * Usage:
 *   node scripts/reconstruct-history.js [session_uuid_or_id]
 *
 * If no argument given, uses the most recently modified session.
 *
 * Env vars:
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 *   or INKFLOW_DATABASE_URL
 */
'use strict';

const { Client } = require('pg');

const PART_KIND_LABELS = {
    null: '💬 AI Text',
    thinking: '🧠 Thinking',
    toolInvocationSerialized: '🔧 Tool Call',
    textEditGroup: '✏️  File Edit',
    inlineReference: '📎 Reference',
    codeblockUri: '📄 Code Block',
    undoStop: '⏸  Undo Stop',
    mcpServersStarting: '🔌 MCP',
};

function labelFor(kind) {
    return PART_KIND_LABELS[kind] || `[${kind}]`;
}

function hr(char = '─', len = 80) {
    return char.repeat(len);
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

    try {
        // ── Resolve session ──
        const arg = process.argv[2];
        let sessionRow;

        if (arg) {
            const isNumeric = /^\d+$/.test(arg);
            const res = isNumeric
                ? await client.query(
                    `SELECT s.*, w.folder_uri FROM sessions s
                     JOIN workspaces w ON w.id = s.workspace_id
                     WHERE s.id = $1 AND s.deleted_at IS NULL`, [parseInt(arg)])
                : await client.query(
                    `SELECT s.*, w.folder_uri FROM sessions s
                     JOIN workspaces w ON w.id = s.workspace_id
                     WHERE s.session_uuid = $1 AND s.deleted_at IS NULL`, [arg]);
            sessionRow = res.rows[0];
        } else {
            const res = await client.query(
                `SELECT s.*, w.folder_uri FROM sessions s
                 JOIN workspaces w ON w.id = s.workspace_id
                 WHERE s.deleted_at IS NULL
                 ORDER BY s.last_modified_at DESC
                 LIMIT 1`
            );
            sessionRow = res.rows[0];
        }

        if (!sessionRow) {
            console.error('Session not found.');
            process.exit(1);
        }

        const sessionId = sessionRow.id;

        console.log(hr('═'));
        console.log(`SESSION: ${sessionRow.session_uuid}`);
        console.log(`Title  : ${sessionRow.custom_title || sessionRow.title || '(untitled)'}`);
        console.log(`Workspace: ${decodeURIComponent(sessionRow.folder_uri || '')}`);
        console.log(`Turns  : ${sessionRow.turn_count}`);
        console.log(`Last modified: ${sessionRow.last_modified_at}`);
        console.log(hr('═'));

        // ── Check if turns table exists ──
        const tableCheck = await client.query(
            `SELECT to_regclass('public.turns') AS t`
        );
        const hasTurns = tableCheck.rows[0]?.t !== null;

        if (!hasTurns) {
            console.log('\n⚠️  Migration 002 not yet applied — showing messages table only.\n');
            await showMessagesOnly(client, sessionId);
            return;
        }

        // ── Fetch all turns ──
        const turnsRes = await client.query(
            `SELECT t.*, 
                    to_char(to_timestamp(t.timestamp_ms / 1000.0), 'YYYY-MM-DD HH24:MI:SS') AS ts_fmt,
                    to_char(to_timestamp(t.completed_at_ms / 1000.0), 'YYYY-MM-DD HH24:MI:SS') AS done_fmt
             FROM turns t
             WHERE t.session_id = $1 AND t.deleted_at IS NULL
             ORDER BY t.turn_index ASC`,
            [sessionId]
        );

        if (turnsRes.rows.length === 0) {
            console.log('\n⚠️  No turns stored yet. The extension may not have processed this session yet.\n');
            await showMessagesOnly(client, sessionId);
            return;
        }

        for (const turn of turnsRes.rows) {
            console.log(`\n${hr()}`);
            console.log(`TURN ${turn.turn_index + 1}  |  Model: ${turn.model_id || 'unknown'}  |  Agent: ${turn.agent_id || 'unknown'}`);
            if (turn.ts_fmt) console.log(`Started: ${turn.ts_fmt}  →  Completed: ${turn.done_fmt || 'n/a'}`);
            console.log(hr());

            // User message
            console.log('\n👤 USER:');
            console.log(turn.user_text || '(empty)');

            // All response parts in order
            const partsRes = await client.query(
                `SELECT part_index, kind, content, raw_json
                 FROM turn_parts
                 WHERE turn_id = $1
                 ORDER BY part_index ASC`,
                [turn.id]
            );

            if (partsRes.rows.length === 0) {
                console.log('\n(No response parts captured yet — response may still be streaming)');
                continue;
            }

            let currentKind = '__UNSET__';

            for (const part of partsRes.rows) {
                const kindKey = part.kind === null ? 'null' : part.kind;

                // Print section header when kind changes
                if (kindKey !== currentKind) {
                    currentKind = kindKey;
                    console.log(`\n${labelFor(part.kind ?? null)}:`);
                }

                if (part.kind === null) {
                    // Plain text — just print value
                    process.stdout.write(part.content || '');
                } else if (part.kind === 'thinking') {
                    console.log(part.content || '');
                } else if (part.kind === 'toolInvocationSerialized') {
                    const raw = part.raw_json;
                    const msg = raw?.invocationMessage?.value || raw?.pastTenseMessage?.value || part.content;
                    const state = raw?.toolSpecificData?.kind || (raw?.result ? 'completed' : 'invoked');
                    console.log(`  [${state}] ${msg || '(no message)'}`);
                    if (raw?.result?.content) {
                        const resultText = Array.isArray(raw.result.content)
                            ? raw.result.content.map(c => c.text || '').join('')
                            : String(raw.result.content);
                        if (resultText.trim()) {
                            console.log(`  Result: ${resultText.slice(0, 200)}${resultText.length > 200 ? '…' : ''}`);
                        }
                    }
                } else if (part.kind === 'textEditGroup') {
                    const raw = part.raw_json;
                    const file = raw?.uri?.fsPath || raw?.uri?.path || part.content || '(unknown file)';
                    console.log(`  Edited: ${file}`);
                } else if (part.kind === 'inlineReference') {
                    console.log(`  → ${part.content || '(reference)'}`);
                } else if (part.kind === 'codeblockUri') {
                    console.log(`  File: ${part.content || '(unknown)'}`);
                } else if (part.kind === 'undoStop' || part.kind === 'mcpServersStarting') {
                    // Minor lifecycle event — skip verbose output
                }
            }

            // Ensure text output ends with newline
            if (currentKind === 'null') process.stdout.write('\n');
        }

        // Summary stats
        const statsRes = await client.query(
            `SELECT 
                COUNT(DISTINCT tp.turn_id) AS turns_with_parts,
                COUNT(tp.id) AS total_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind IS NULL) AS text_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'thinking') AS thinking_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'toolInvocationSerialized') AS tool_parts,
                COUNT(tp.id) FILTER (WHERE tp.kind = 'textEditGroup') AS edit_parts
             FROM turns t
             JOIN turn_parts tp ON tp.turn_id = t.id
             WHERE t.session_id = $1 AND t.deleted_at IS NULL`,
            [sessionId]
        );
        const s = statsRes.rows[0];

        console.log(`\n${hr('═')}`);
        console.log('RECONSTRUCTION SUMMARY');
        console.log(hr('═'));
        console.log(`Turns with parts : ${s.turns_with_parts}`);
        console.log(`Total parts      : ${s.total_parts}`);
        console.log(`  Text chunks    : ${s.text_parts}`);
        console.log(`  Thinking steps : ${s.thinking_parts}`);
        console.log(`  Tool calls     : ${s.tool_parts}`);
        console.log(`  File edits     : ${s.edit_parts}`);
        console.log(hr('═'));
    } finally {
        await client.end();
    }
}

async function showMessagesOnly(client, sessionId) {
    const res = await client.query(
        `SELECT role, request_index, LEFT(content, 300) AS content_preview, created_at
         FROM messages
         WHERE session_id = $1 AND deleted_at IS NULL
         ORDER BY request_index, role`,
        [sessionId]
    );
    for (const row of res.rows) {
        console.log(`\n[${row.role.toUpperCase()} - turn ${row.request_index + 1}] ${row.created_at}`);
        console.log(row.content_preview);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
