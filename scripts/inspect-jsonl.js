#!/usr/bin/env node
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('Usage: node inspect-jsonl.js <file>'); process.exit(1); }

const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

function applyPatch(state, entry) {
    if (entry.kind === 0) return JSON.parse(JSON.stringify(entry.v));
    const path = entry.k;
    if (!path || path.length === 0) return state;
    let cur = state;
    for (let i = 0; i < path.length - 1; i++) {
        if (cur[path[i]] === undefined) cur[path[i]] = {};
        cur = cur[path[i]];
    }
    const last = path[path.length - 1];
    if (entry.kind === 1) { cur[last] = entry.v; }
    else if (entry.kind === 2) {
        if (!Array.isArray(cur[last])) cur[last] = [];
        if (entry.i !== undefined) cur[last].length = entry.i;
        if (Array.isArray(entry.v)) cur[last].push(...entry.v);
    } else if (entry.kind === 3) { delete cur[last]; }
    return state;
}

let state = null;
for (const l of lines) { state = applyPatch(state, JSON.parse(l)); }

console.log('=== SESSION TOP-LEVEL KEYS ===');
console.log(Object.keys(state));
console.log('\n=== REQUESTS COUNT:', state.requests ? state.requests.length : 0, '===');

const kindSamples = {};
(state.requests || []).forEach((req, ri) => {
    const resp = req.response;
    if (Array.isArray(resp)) {
        resp.forEach(p => {
            const k = p.kind !== undefined ? p.kind : '__text__';
            if (!kindSamples[k]) kindSamples[k] = { reqIdx: ri, sample: p };
        });
    }
});

console.log('\n=== UNIQUE RESPONSE PART KINDS ===');
console.log(Object.keys(kindSamples));

for (const [k, s] of Object.entries(kindSamples)) {
    console.log('\n--- kind:', k, '(request', s.reqIdx, ')---');
    console.log(JSON.stringify(s.sample, null, 2).slice(0, 600));
}

// Show full request[0] structure (minus response array)
const req0 = state.requests && state.requests[0] ? { ...state.requests[0] } : null;
if (req0) {
    const respLen = Array.isArray(req0.response) ? req0.response.length : 0;
    req0.response = `[Array of ${respLen} parts]`;
    console.log('\n=== REQUEST[0] KEYS & STRUCTURE ===');
    console.log(JSON.stringify(req0, null, 2).slice(0, 1500));
}

// Count tool invocations
let toolCount = 0;
(state.requests || []).forEach(req => {
    if (Array.isArray(req.response)) {
        req.response.forEach(p => {
            if (p.kind === 'toolInvocationSerialized') toolCount++;
        });
    }
});
console.log('\n=== TOTAL TOOL INVOCATIONS ACROSS ALL REQUESTS:', toolCount, '===');
