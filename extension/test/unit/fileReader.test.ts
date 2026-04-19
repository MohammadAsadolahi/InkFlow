import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readNewLines, readHeaderHash } from '../../src/watcher/fileReader';

describe('readNewLines', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-reader-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads all lines from a new file (offset 0)', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, [
            '{"kind":0,"v":{"version":3,"requests":[]}}',
            '{"kind":1,"k":["title"],"v":"Hello"}',
            '{"kind":2,"k":["requests"],"v":[{"text":"msg1"}]}',
        ].join('\n') + '\n');

        const result = await readNewLines(filePath, 0, true);

        expect(result.lines).toHaveLength(3);
        expect(result.lines[0].entry.kind).toBe(0);
        expect(result.lines[1].entry.kind).toBe(1);
        expect(result.lines[2].entry.kind).toBe(2);
        expect(result.headerHash).not.toBeNull();
        expect(result.consumedUpTo).toBeGreaterThan(0);
    });

    it('reads only new lines from offset', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        const line1 = '{"kind":0,"v":{"version":3}}';
        const line2 = '{"kind":1,"k":["title"],"v":"Test"}';

        // Write first line
        fs.writeFileSync(filePath, line1 + '\n');
        const firstResult = await readNewLines(filePath, 0, true);
        expect(firstResult.lines).toHaveLength(1);

        // Append second line
        fs.appendFileSync(filePath, line2 + '\n');

        // Read from where we left off
        const secondResult = await readNewLines(filePath, firstResult.consumedUpTo, true);
        expect(secondResult.lines).toHaveLength(1);
        expect(secondResult.lines[0].entry.kind).toBe(1);
    });

    it('handles partial line at EOF (waits for completion)', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        const completeLine = '{"kind":0,"v":{"version":3}}';
        const partialLine = '{"kind":1,"k":["ti';

        fs.writeFileSync(filePath, completeLine + '\n' + partialLine);

        const result = await readNewLines(filePath, 0, true);

        // Should only return the complete line
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].entry.kind).toBe(0);
        // consumedUpTo should NOT include the partial line
        expect(result.consumedUpTo).toBe(Buffer.byteLength(completeLine, 'utf8') + 1);
    });

    it('filters inputState events when enabled', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, [
            '{"kind":0,"v":{"version":3}}',
            '{"kind":1,"k":["inputState","value"],"v":"typing..."}',
            '{"kind":1,"k":["title"],"v":"Real Data"}',
        ].join('\n') + '\n');

        const result = await readNewLines(filePath, 0, true);

        // inputState should be filtered out
        expect(result.lines).toHaveLength(2);
        expect(result.lines[0].entry.kind).toBe(0);
        expect(result.lines[1].entry.kind).toBe(1);
        expect((result.lines[1].entry as any).k[0]).toBe('title');
    });

    it('does NOT filter inputState when disabled', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, [
            '{"kind":0,"v":{"version":3}}',
            '{"kind":1,"k":["inputState","value"],"v":"typing..."}',
        ].join('\n') + '\n');

        const result = await readNewLines(filePath, 0, false);
        expect(result.lines).toHaveLength(2);
    });

    it('produces unique hashes for different byte offsets', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, [
            '{"kind":0,"v":{"version":3}}',
            '{"kind":1,"k":["a"],"v":1}',
            '{"kind":1,"k":["b"],"v":2}',
        ].join('\n') + '\n');

        const result = await readNewLines(filePath, 0, true);
        const hashes = result.lines.map(l => l.eventHash.toString('hex'));

        // All hashes should be unique
        const uniqueHashes = new Set(hashes);
        expect(uniqueHashes.size).toBe(3);
    });

    it('returns empty result for non-existent file', async () => {
        const result = await readNewLines(path.join(tmpDir, 'nonexistent.jsonl'), 0, true);
        expect(result.lines).toHaveLength(0);
        expect(result.consumedUpTo).toBe(0);
    });

    it('returns empty result when file has not grown', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, '{"kind":0,"v":{}}\n');

        const stat = fs.statSync(filePath);
        const result = await readNewLines(filePath, stat.size, true);
        expect(result.lines).toHaveLength(0);
    });

    it('handles empty file', async () => {
        const filePath = path.join(tmpDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '');

        const result = await readNewLines(filePath, 0, true);
        expect(result.lines).toHaveLength(0);
    });

    it('handles kind=2 with v and i coexisting', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath,
            '{"kind":2,"k":["requests"],"i":1,"v":[{"text":"forked"}]}\n'
        );

        const result = await readNewLines(filePath, 0, true);
        expect(result.lines).toHaveLength(1);
        const entry = result.lines[0].entry;
        expect(entry.kind).toBe(2);
        expect((entry as any).i).toBe(1);
        expect((entry as any).v).toEqual([{ text: 'forked' }]);
    });

    it('handles kind=3 (delete)', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, '{"kind":3,"k":["tempField"]}\n');

        const result = await readNewLines(filePath, 0, true);
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].entry.kind).toBe(3);
    });
});

describe('readHeaderHash', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-header-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns hash of first line', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');
        fs.writeFileSync(filePath, '{"kind":0,"v":{"version":3}}\n{"kind":1}\n');

        const hash = await readHeaderHash(filePath);
        expect(hash).not.toBeNull();
        expect(hash!.length).toBe(32);
    });

    it('returns same hash for same first line', async () => {
        const file1 = path.join(tmpDir, 'a.jsonl');
        const file2 = path.join(tmpDir, 'b.jsonl');
        const firstLine = '{"kind":0,"v":{"version":3,"sessionId":"same"}}';

        fs.writeFileSync(file1, firstLine + '\n');
        fs.writeFileSync(file2, firstLine + '\n{"kind":1}\n');

        const h1 = await readHeaderHash(file1);
        const h2 = await readHeaderHash(file2);
        expect(h1!.equals(h2!)).toBe(true);
    });

    it('returns different hash after compaction (file rewrite)', async () => {
        const filePath = path.join(tmpDir, 'test.jsonl');

        fs.writeFileSync(filePath, '{"kind":0,"v":{"version":3,"requests":[]}}\n');
        const h1 = await readHeaderHash(filePath);

        // Simulate compaction: rewrite with different first line
        fs.writeFileSync(filePath, '{"kind":0,"v":{"version":3,"requests":[{"text":"compacted"}]}}\n');
        const h2 = await readHeaderHash(filePath);

        expect(h1!.equals(h2!)).toBe(false);
    });

    it('returns null for empty file', async () => {
        const filePath = path.join(tmpDir, 'empty.jsonl');
        fs.writeFileSync(filePath, '');
        const hash = await readHeaderHash(filePath);
        expect(hash).toBeNull();
    });

    it('returns null for non-existent file', async () => {
        const hash = await readHeaderHash(path.join(tmpDir, 'nope.jsonl'));
        expect(hash).toBeNull();
    });
});
