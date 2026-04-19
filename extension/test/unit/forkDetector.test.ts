import { describe, it, expect } from 'vitest';
import { detectFork } from '../../src/parser/forkDetector';
import type { JsonlEntry } from '../../src/types';

describe('detectFork', () => {
    describe('true fork cases', () => {
        it('detects fork: truncate to 1, push replacement (3→2 turns)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 1,
                v: [{ message: { content: 'forked' } }],
            };
            const result = detectFork(entry, 3);
            expect(result).not.toBeNull();
            expect(result!.forkAt).toBe(1);
            expect(result!.newItems).toHaveLength(1);
            expect(result!.previousTurnCount).toBe(3);
        });

        it('detects fork: truncate to 0, push fresh start', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 0,
                v: [{ message: { content: 'start over' } }],
            };
            const result = detectFork(entry, 5);
            expect(result).not.toBeNull();
            expect(result!.forkAt).toBe(0);
        });

        it('detects fork: truncate only (no new items)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 2,
            };
            const result = detectFork(entry, 4);
            expect(result).not.toBeNull();
            expect(result!.forkAt).toBe(2);
            expect(result!.newItems).toEqual([]);
        });
    });

    describe('false positive prevention', () => {
        it('rejects kind=0 (initial state)', () => {
            const entry: JsonlEntry = { kind: 0, v: { requests: [] } };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects kind=1 (set)', () => {
            const entry: JsonlEntry = { kind: 1, k: ['requests'], v: 'something' };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects kind=3 (delete)', () => {
            const entry: JsonlEntry = { kind: 3, k: ['requests'] };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects streaming response update (k.length > 1)', () => {
            // This is a response streaming update, NOT a fork
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests', 0, 'response', 'parts'],
                i: 1,
                v: [{ content: 'streamed' }],
            };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects deep nested path (tool result)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests', 0, 'response', 2, 'result'],
                i: 0,
                v: ['result data'],
            };
            expect(detectFork(entry, 1)).toBeNull();
        });

        it('rejects pure append (i === currentTurnCount)', () => {
            // i equals turn count = just appending, not truncating
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 3,
                v: [{ message: { content: 'new turn' } }],
            };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects pure append (no i field)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                v: [{ message: { content: 'new turn' } }],
            };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects non-requests key', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['otherArray'],
                i: 1,
                v: ['item'],
            };
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('rejects when turn count is 0 (nothing to fork)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 0,
                v: [{ message: { content: 'first' } }],
            };
            // i=0 is NOT < currentTurnCount=0
            expect(detectFork(entry, 0)).toBeNull();
        });
    });

    describe('edge cases', () => {
        it('fork at last turn (i = turnCount - 1)', () => {
            const entry: JsonlEntry = {
                kind: 2,
                k: ['requests'],
                i: 4,
                v: [{ message: { content: 'replace last' } }],
            };
            const result = detectFork(entry, 5);
            expect(result).not.toBeNull();
            expect(result!.forkAt).toBe(4);
        });

        it('handles missing k array', () => {
            const entry = { kind: 2, i: 1, v: ['x'] } as unknown as JsonlEntry;
            expect(detectFork(entry, 3)).toBeNull();
        });

        it('handles empty k array', () => {
            const entry: JsonlEntry = { kind: 2, k: [], i: 1, v: ['x'] };
            expect(detectFork(entry, 3)).toBeNull();
        });
    });
});
