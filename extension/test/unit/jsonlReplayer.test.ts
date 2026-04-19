import { describe, it, expect } from 'vitest';
import { applyPatch, JsonlReplayer, parseJsonlLine } from '../../src/parser/jsonlReplayer';
import type { JsonlEntry } from '../../src/types';

describe('parseJsonlLine', () => {
    it('parses kind=0 (initial)', () => {
        const result = parseJsonlLine('{"kind":0,"v":{"version":3,"requests":[]}}');
        expect(result).toEqual({ kind: 0, v: { version: 3, requests: [] } });
    });

    it('parses kind=1 (set)', () => {
        const result = parseJsonlLine('{"kind":1,"k":["title"],"v":"Hello"}');
        expect(result).toEqual({ kind: 1, k: ['title'], v: 'Hello' });
    });

    it('parses kind=2 with both v and i (truncate-then-push)', () => {
        const result = parseJsonlLine('{"kind":2,"k":["requests"],"i":1,"v":[{"text":"new"}]}');
        expect(result).toEqual({ kind: 2, k: ['requests'], i: 1, v: [{ text: 'new' }] });
    });

    it('parses kind=2 with only v (pure push)', () => {
        const result = parseJsonlLine('{"kind":2,"k":["requests"],"v":[{"text":"appended"}]}');
        expect(result).toEqual({ kind: 2, k: ['requests'], v: [{ text: 'appended' }] });
    });

    it('parses kind=2 with only i (pure truncation)', () => {
        const result = parseJsonlLine('{"kind":2,"k":["requests"],"i":2}');
        expect(result).toEqual({ kind: 2, k: ['requests'], i: 2 });
    });

    it('parses kind=3 (delete)', () => {
        const result = parseJsonlLine('{"kind":3,"k":["tempField"]}');
        expect(result).toEqual({ kind: 3, k: ['tempField'] });
    });

    it('returns null for empty string', () => {
        expect(parseJsonlLine('')).toBeNull();
        expect(parseJsonlLine('   ')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
        expect(parseJsonlLine('{broken')).toBeNull();
    });

    it('returns null for missing kind', () => {
        expect(parseJsonlLine('{"v":"no kind"}')).toBeNull();
    });

    it('returns null for invalid kind', () => {
        expect(parseJsonlLine('{"kind":5,"v":"bad"}')).toBeNull();
    });

    it('returns null for non-object', () => {
        expect(parseJsonlLine('"just a string"')).toBeNull();
        expect(parseJsonlLine('42')).toBeNull();
        expect(parseJsonlLine('null')).toBeNull();
    });
});

describe('applyPatch', () => {
    describe('kind=0 (initial)', () => {
        it('replaces entire state', () => {
            const result = applyPatch(null, { kind: 0, v: { version: 3, requests: [] } });
            expect(result).toEqual({ version: 3, requests: [] });
        });

        it('replaces existing state on compaction', () => {
            const existing = { version: 3, requests: [{ text: 'old' }] };
            const result = applyPatch(existing, { kind: 0, v: { version: 3, requests: [{ text: 'compacted' }] } });
            expect(result).toEqual({ version: 3, requests: [{ text: 'compacted' }] });
        });

        it('deep clones the value (no shared references)', () => {
            const original = { nested: { arr: [1, 2, 3] } };
            const result = applyPatch(null, { kind: 0, v: original });
            original.nested.arr.push(4);
            expect(result.nested.arr).toEqual([1, 2, 3]); // not affected
        });
    });

    describe('kind=1 (set)', () => {
        it('sets a top-level property', () => {
            const state = { version: 3, title: '' };
            applyPatch(state, { kind: 1, k: ['title'], v: 'New Title' });
            expect(state.title).toBe('New Title');
        });

        it('sets a nested property', () => {
            const state = { requests: [{ response: { text: '' } }] };
            applyPatch(state, { kind: 1, k: ['requests', 0, 'response', 'text'], v: 'Hello world' });
            expect(state.requests[0].response.text).toBe('Hello world');
        });

        it('creates intermediate objects if missing', () => {
            const state: any = {};
            applyPatch(state, { kind: 1, k: ['a', 'b', 'c'], v: 42 });
            expect(state.a.b.c).toBe(42);
        });

        it('sets value to null', () => {
            const state = { field: 'something' };
            applyPatch(state, { kind: 1, k: ['field'], v: null });
            expect(state.field).toBeNull();
        });
    });

    describe('kind=2 (truncate-then-push)', () => {
        it('pushes items without truncation (pure append)', () => {
            const state = { requests: [{ text: 'first' }] };
            applyPatch(state, { kind: 2, k: ['requests'], v: [{ text: 'second' }] });
            expect(state.requests).toHaveLength(2);
            expect(state.requests[1]).toEqual({ text: 'second' });
        });

        it('pushes multiple items at once', () => {
            const state = { requests: [] as any[] };
            applyPatch(state, { kind: 2, k: ['requests'], v: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
            expect(state.requests).toHaveLength(3);
        });

        it('truncates to length i then pushes v (fork pattern)', () => {
            const state = { requests: [{ text: 'turn1' }, { text: 'turn2' }, { text: 'turn3' }] };
            // Fork: go back to turn 1, replace with new turn
            applyPatch(state, { kind: 2, k: ['requests'], i: 1, v: [{ text: 'forked' }] });
            expect(state.requests).toHaveLength(2);
            expect(state.requests[0]).toEqual({ text: 'turn1' });
            expect(state.requests[1]).toEqual({ text: 'forked' });
        });

        it('truncates only (no push) when v is absent', () => {
            const state = { requests: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] };
            applyPatch(state, { kind: 2, k: ['requests'], i: 1 });
            expect(state.requests).toHaveLength(1);
            expect(state.requests[0]).toEqual({ text: 'a' });
        });

        it('truncates to 0 then pushes (complete replacement)', () => {
            const state = { requests: [{ text: 'old1' }, { text: 'old2' }] };
            applyPatch(state, { kind: 2, k: ['requests'], i: 0, v: [{ text: 'fresh' }] });
            expect(state.requests).toHaveLength(1);
            expect(state.requests[0]).toEqual({ text: 'fresh' });
        });

        it('handles streaming response updates on sub-paths (NOT a fork)', () => {
            const state = {
                requests: [{
                    response: {
                        parts: ['part1', 'part2']
                    }
                }]
            };
            // Streaming: truncate response parts then push new content
            applyPatch(state, {
                kind: 2,
                k: ['requests', 0, 'response', 'parts'],
                i: 1,
                v: ['updated_part2', 'part3']
            });
            expect(state.requests[0].response.parts).toEqual(['part1', 'updated_part2', 'part3']);
        });

        it('creates array if property does not exist', () => {
            const state: any = { requests: [{ response: {} }] };
            applyPatch(state, { kind: 2, k: ['requests', 0, 'response', 'parts'], v: ['first'] });
            expect(state.requests[0].response.parts).toEqual(['first']);
        });

        it('creates array if property is not an array', () => {
            const state: any = { items: 'not an array' };
            applyPatch(state, { kind: 2, k: ['items'], v: ['a'] });
            expect(state.items).toEqual(['a']);
        });

        it('v and i coexist — the most common pattern', () => {
            const state = { data: ['x', 'y', 'z'] };
            // Truncate to 2, push 'w' → ['x', 'y', 'w']
            applyPatch(state, { kind: 2, k: ['data'], i: 2, v: ['w'] });
            expect(state.data).toEqual(['x', 'y', 'w']);
        });
    });

    describe('kind=3 (delete)', () => {
        it('deletes a top-level property', () => {
            const state: any = { a: 1, b: 2 };
            applyPatch(state, { kind: 3, k: ['b'] });
            expect(state).toEqual({ a: 1 });
            expect('b' in state).toBe(false);
        });

        it('deletes a nested property', () => {
            const state = { outer: { inner: 'value', keep: true } };
            applyPatch(state, { kind: 3, k: ['outer', 'inner'] });
            expect(state.outer).toEqual({ keep: true });
        });
    });

    describe('edge cases', () => {
        it('handles empty k path gracefully', () => {
            const state = { a: 1 };
            const result = applyPatch(state, { kind: 1, k: [], v: 'ignored' });
            expect(result).toEqual({ a: 1 }); // no change
        });
    });
});

describe('JsonlReplayer', () => {
    it('replays a full chat session from JSONL entries', () => {
        const replayer = new JsonlReplayer();

        // Line 1: Initial state
        replayer.apply({ kind: 0, v: { version: 3, sessionId: 'abc-123', requests: [] } });
        expect(replayer.getState().requests).toHaveLength(0);

        // Line 2: First user message (push)
        replayer.apply({
            kind: 2, k: ['requests'],
            v: [{ message: { role: 'user', content: 'Hello' }, response: { parts: [] } }]
        });
        expect(replayer.getState().requests).toHaveLength(1);
        expect(replayer.getState().requests[0].message.content).toBe('Hello');

        // Line 3: Assistant response starts streaming
        replayer.apply({
            kind: 2, k: ['requests', 0, 'response', 'parts'],
            v: [{ kind: 'markdownContent', content: { value: 'Hi there' } }]
        });
        expect(replayer.getState().requests[0].response.parts).toHaveLength(1);

        // Line 4: Streaming update — truncate-then-push on response
        replayer.apply({
            kind: 2, k: ['requests', 0, 'response', 'parts'],
            i: 0,
            v: [{ kind: 'markdownContent', content: { value: 'Hi there! How can I help?' } }]
        });
        expect(replayer.getState().requests[0].response.parts[0].content.value)
            .toBe('Hi there! How can I help?');

        // Line 5: Set title
        replayer.apply({ kind: 1, k: ['customTitle'], v: 'Greeting Chat' });
        expect(replayer.getState().customTitle).toBe('Greeting Chat');

        // Line 6: Second turn
        replayer.apply({
            kind: 2, k: ['requests'],
            v: [{ message: { role: 'user', content: 'What is 2+2?' }, response: { parts: [] } }]
        });
        expect(replayer.getState().requests).toHaveLength(2);

        expect(replayer.getLineCount()).toBe(6);
    });

    it('replays a fork scenario correctly', () => {
        const replayer = new JsonlReplayer();

        // Initial state with 3 turns
        replayer.apply({
            kind: 0,
            v: {
                version: 3,
                requests: [
                    { message: { content: 'turn1' } },
                    { message: { content: 'turn2' } },
                    { message: { content: 'turn3' } },
                ]
            }
        });
        expect(replayer.getState().requests).toHaveLength(3);

        // Fork: truncate to 1, push replacement
        replayer.apply({
            kind: 2, k: ['requests'], i: 1,
            v: [{ message: { content: 'forked_turn2' } }]
        });

        const state = replayer.getState();
        expect(state.requests).toHaveLength(2);
        expect(state.requests[0].message.content).toBe('turn1');
        expect(state.requests[1].message.content).toBe('forked_turn2');
    });

    it('handles compaction (new kind=0 replacing entire state)', () => {
        const replayer = new JsonlReplayer();

        // Build up state with many patches
        replayer.apply({ kind: 0, v: { requests: [] } });
        for (let i = 0; i < 5; i++) {
            replayer.apply({ kind: 2, k: ['requests'], v: [{ text: `msg${i}` }] });
        }
        expect(replayer.getState().requests).toHaveLength(5);

        // Compaction: fresh kind=0 replaces everything
        replayer.reset(); // simulate file rewrite detection
        replayer.apply({
            kind: 0,
            v: { requests: [{ text: 'msg0' }, { text: 'msg1' }, { text: 'msg2' }, { text: 'msg3' }, { text: 'msg4' }] }
        });
        expect(replayer.getState().requests).toHaveLength(5);
        expect(replayer.getLineCount()).toBe(1);
    });

    it('replayAll processes multiple entries', () => {
        const replayer = new JsonlReplayer();
        const entries: JsonlEntry[] = [
            { kind: 0, v: { items: [] } },
            { kind: 2, k: ['items'], v: ['a'] },
            { kind: 2, k: ['items'], v: ['b'] },
            { kind: 1, k: ['title'], v: 'test' },
        ];
        const state = replayer.replayAll(entries);
        expect(state.items).toEqual(['a', 'b']);
        expect(state.title).toBe('test');
        expect(replayer.getLineCount()).toBe(4);
    });

    it('reset clears state', () => {
        const replayer = new JsonlReplayer();
        replayer.apply({ kind: 0, v: { data: true } });
        replayer.reset();
        expect(replayer.getState()).toBeNull();
        expect(replayer.getLineCount()).toBe(0);
    });
});
