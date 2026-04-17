import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalEventQueue } from '../../src/processor/localQueue';

const mockLog = {
    info: () => { },
    warn: () => { },
    error: () => { },
};

function makeEvent(id: number) {
    return {
        eventHash: Buffer.alloc(32, id).toString('hex'),
        workspaceId: 1,
        sessionFile: '/test/session.jsonl',
        byteOffset: id * 100,
        kind: 0,
        keyPath: null,
        rawContent: { kind: 0, v: { id } },
        fileMtimeMs: null,
        instanceId: 'test-instance',
    };
}

describe('LocalEventQueue', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-queue-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('enqueues and drains events', async () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        queue.enqueue(makeEvent(1));
        queue.enqueue(makeEvent(2));

        const processed: any[] = [];
        const count = await queue.drain(async (event) => {
            processed.push(event);
        });

        expect(count).toBe(2);
        expect(processed).toHaveLength(2);
    });

    it('spills to disk when memory limit is reached', () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);

        // Enqueue more than maxMemorySize (1000)
        for (let i = 0; i < 1001; i++) {
            queue.enqueue(makeEvent(i));
        }

        // After spill, memory should be nearly empty (last batch stays)
        expect(queue.getMemorySize()).toBeLessThan(1000);

        // Disk file should exist
        const diskFile = path.join(tmpDir, 'event-queue-inst-1.jsonl');
        expect(fs.existsSync(diskFile)).toBe(true);
    });

    it('survives crash: events on disk are recovered', async () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        queue.enqueue(makeEvent(1));
        queue.enqueue(makeEvent(2));
        queue.flushToDiskSync();

        // Simulate crash: create new queue instance (same path)
        const recovered = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        const processed: any[] = [];
        const count = await recovered.drain(async (event) => {
            processed.push(event);
        });

        expect(count).toBe(2);
        expect(processed).toHaveLength(2);
    });

    it('keeps unprocessed events on drain failure', async () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        queue.enqueue(makeEvent(1));
        queue.enqueue(makeEvent(2));
        queue.enqueue(makeEvent(3));

        let callCount = 0;
        await queue.drain(async () => {
            callCount++;
            if (callCount === 2) throw new Error('DB error');
        });

        // Event 1 processed, event 2 failed, event 3 not attempted
        // Disk file should have events 2 and 3
        const diskFile = path.join(tmpDir, 'event-queue-inst-1.jsonl');
        const remaining = fs.readFileSync(diskFile, 'utf8').split('\n').filter(l => l.trim());
        expect(remaining).toHaveLength(2);
    });

    it('per-window queue files are isolated', () => {
        const q1 = new LocalEventQueue(tmpDir, 'window-1', mockLog);
        const q2 = new LocalEventQueue(tmpDir, 'window-2', mockLog);

        q1.enqueue(makeEvent(1));
        q1.flushToDiskSync();
        q2.enqueue(makeEvent(2));
        q2.flushToDiskSync();

        expect(fs.existsSync(path.join(tmpDir, 'event-queue-window-1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'event-queue-window-2.jsonl'))).toBe(true);
    });

    it('recoverOrphans processes files from crashed instances', async () => {
        // Simulate a crashed instance's queue file
        const orphanFile = path.join(tmpDir, 'event-queue-crashed-inst.jsonl');
        fs.writeFileSync(orphanFile, JSON.stringify(makeEvent(99)) + '\n');

        const processed: any[] = [];
        const count = await LocalEventQueue.recoverOrphans(
            tmpDir,
            async (event) => { processed.push(event); },
            'active-inst',
            mockLog,
        );

        expect(count).toBe(1);
        expect(processed).toHaveLength(1);
        // Orphan file should be deleted
        expect(fs.existsSync(orphanFile)).toBe(false);
    });

    it('recoverOrphans skips active instance file', async () => {
        // Active instance's queue file
        const activeFile = path.join(tmpDir, 'event-queue-my-inst.jsonl');
        fs.writeFileSync(activeFile, JSON.stringify(makeEvent(1)) + '\n');

        const processed: any[] = [];
        await LocalEventQueue.recoverOrphans(
            tmpDir,
            async (event) => { processed.push(event); },
            'my-inst',
            mockLog,
        );

        expect(processed).toHaveLength(0);
        // Active file should NOT be deleted
        expect(fs.existsSync(activeFile)).toBe(true);
    });

    it('disk file cleaned up after successful drain', async () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        queue.enqueue(makeEvent(1));
        queue.flushToDiskSync();

        const diskFile = path.join(tmpDir, 'event-queue-inst-1.jsonl');
        expect(fs.existsSync(diskFile)).toBe(true);

        await queue.drain(async () => { });

        expect(fs.existsSync(diskFile)).toBe(false);
    });

    it('getPendingCount returns memory + disk count', () => {
        const queue = new LocalEventQueue(tmpDir, 'inst-1', mockLog);
        queue.enqueue(makeEvent(1)); // in memory
        queue.enqueue(makeEvent(2)); // in memory

        expect(queue.getPendingCount()).toBe(2);

        queue.flushToDiskSync();
        queue.enqueue(makeEvent(3)); // new in memory

        expect(queue.getPendingCount()).toBe(3); // 2 on disk + 1 in memory
    });
});
