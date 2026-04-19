import { describe, it, expect } from 'vitest';
import { computeEventHash, computeHeaderHash, computeContentHash } from '../../src/utils/hash';

describe('computeEventHash', () => {
    it('produces 32-byte SHA-256 buffer', () => {
        const hash = computeEventHash('/path/file.jsonl', 0, '{"kind":0,"v":{}}');
        expect(hash).toBeInstanceOf(Buffer);
        expect(hash.length).toBe(32);
    });

    it('same inputs produce same hash (deterministic)', () => {
        const h1 = computeEventHash('/path/file.jsonl', 100, '{"kind":1}');
        const h2 = computeEventHash('/path/file.jsonl', 100, '{"kind":1}');
        expect(h1.equals(h2)).toBe(true);
    });

    it('different file paths produce different hashes', () => {
        const h1 = computeEventHash('/path/a.jsonl', 0, '{"kind":0}');
        const h2 = computeEventHash('/path/b.jsonl', 0, '{"kind":0}');
        expect(h1.equals(h2)).toBe(false);
    });

    it('different byte offsets produce different hashes', () => {
        const h1 = computeEventHash('/path/file.jsonl', 0, '{"kind":0}');
        const h2 = computeEventHash('/path/file.jsonl', 100, '{"kind":0}');
        expect(h1.equals(h2)).toBe(false);
    });

    it('different content produces different hashes', () => {
        const h1 = computeEventHash('/path/file.jsonl', 0, '{"kind":0,"v":1}');
        const h2 = computeEventHash('/path/file.jsonl', 0, '{"kind":0,"v":2}');
        expect(h1.equals(h2)).toBe(false);
    });
});

describe('computeHeaderHash', () => {
    it('produces 32-byte hash', () => {
        const hash = computeHeaderHash('{"kind":0,"v":{"version":3}}');
        expect(hash.length).toBe(32);
    });

    it('same first line = same hash', () => {
        const line = '{"kind":0,"v":{"version":3,"sessionId":"abc"}}';
        const h1 = computeHeaderHash(line);
        const h2 = computeHeaderHash(line);
        expect(h1.equals(h2)).toBe(true);
    });

    it('different first line = different hash (compaction detection)', () => {
        const h1 = computeHeaderHash('{"kind":0,"v":{"version":3,"sessionId":"abc"}}');
        const h2 = computeHeaderHash('{"kind":0,"v":{"version":3,"sessionId":"abc","requests":[{"t":"1"}]}}');
        expect(h1.equals(h2)).toBe(false);
    });
});

describe('computeContentHash', () => {
    it('produces 32-byte hash', () => {
        const hash = computeContentHash('Hello world');
        expect(hash.length).toBe(32);
    });

    it('is deterministic', () => {
        const h1 = computeContentHash('test content');
        const h2 = computeContentHash('test content');
        expect(h1.equals(h2)).toBe(true);
    });
});
