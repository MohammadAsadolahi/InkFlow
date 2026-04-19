import * as fs from 'fs';
import * as path from 'path';

interface Logger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
}

interface QueuedEvent {
    eventHash: string; // hex for JSON serialization
    workspaceId: number;
    sessionFile: string;
    byteOffset: number;
    kind: number;
    keyPath: string[] | null;
    rawContent: unknown;
    fileMtimeMs: number | null;
    instanceId: string;
}

/**
 * Write-ahead local event queue.
 * Events are spilled to disk BEFORE being removed from memory.
 * Per-window queue file prevents multi-window races.
 */
export class LocalEventQueue {
    private memoryQueue: QueuedEvent[] = [];
    private readonly diskPath: string;
    private readonly maxMemorySize = 1000;
    private readonly maxDiskBytes = 100 * 1024 * 1024; // 100MB
    private log: Logger;

    constructor(globalStoragePath: string, instanceId: string, log: Logger) {
        // Ensure directory exists
        fs.mkdirSync(globalStoragePath, { recursive: true });
        // Per-window queue file
        this.diskPath = path.join(globalStoragePath, `event-queue-${instanceId}.jsonl`);
        this.log = log;
    }

    enqueue(event: QueuedEvent): void {
        this.memoryQueue.push(event);
        if (this.memoryQueue.length >= this.maxMemorySize) {
            this.flushToDiskSync();
        }
    }

    /** Synchronous spill — called from enqueue and deactivate */
    flushToDiskSync(): void {
        if (this.memoryQueue.length === 0) return;
        try {
            const diskSize = this.getDiskSize();
            if (diskSize > this.maxDiskBytes) {
                this.log.warn(`Event queue disk limit reached (${diskSize} bytes), dropping oldest events`);
                return;
            }
            const lines = this.memoryQueue.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.appendFileSync(this.diskPath, lines);
            this.memoryQueue = [];
        } catch (err) {
            this.log.error('Failed to spill events to disk', err);
        }
    }

    async flushToDisk(): Promise<void> {
        this.flushToDiskSync();
    }

    /**
     * Drain: process events from disk using provided callback.
     * Returns number of events processed.
     */
    async drain(processEvent: (event: QueuedEvent) => Promise<void>): Promise<number> {
        // 1. Spill any in-memory events to disk
        this.flushToDiskSync();

        // 2. Read disk file
        if (!fs.existsSync(this.diskPath)) return 0;

        let content: string;
        try {
            content = fs.readFileSync(this.diskPath, 'utf8');
        } catch {
            return 0;
        }

        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length === 0) return 0;

        let processed = 0;
        const remaining: string[] = [];
        let hitError = false;

        for (const line of lines) {
            if (hitError) {
                remaining.push(line);
                continue;
            }

            let event: QueuedEvent;
            try {
                event = JSON.parse(line);
            } catch {
                processed++; // corrupt line — skip
                continue;
            }

            try {
                await processEvent(event);
                processed++;
            } catch {
                // DB error — stop draining, keep remaining events
                remaining.push(line);
                hitError = true;
            }
        }

        // 3. Rewrite disk file with only unprocessed events
        if (remaining.length > 0) {
            fs.writeFileSync(this.diskPath, remaining.join('\n') + '\n');
        } else {
            try { fs.unlinkSync(this.diskPath); } catch { /* ENOENT fine */ }
        }

        return processed;
    }

    /** Get number of events in memory queue */
    getMemorySize(): number {
        return this.memoryQueue.length;
    }

    /** Get total pending events (memory + disk) */
    getPendingCount(): number {
        let diskCount = 0;
        try {
            if (fs.existsSync(this.diskPath)) {
                const content = fs.readFileSync(this.diskPath, 'utf8');
                diskCount = content.split('\n').filter(l => l.trim()).length;
            }
        } catch { /* ignore */ }
        return this.memoryQueue.length + diskCount;
    }

    private getDiskSize(): number {
        try {
            return fs.statSync(this.diskPath).size;
        } catch {
            return 0;
        }
    }

    /**
     * Scan for orphaned queue files from crashed instances.
     */
    static async recoverOrphans(
        globalStoragePath: string,
        processEvent: (event: QueuedEvent) => Promise<void>,
        activeInstanceId: string,
        log: Logger,
    ): Promise<number> {
        let totalRecovered = 0;

        let files: string[];
        try {
            files = fs.readdirSync(globalStoragePath)
                .filter(f => f.startsWith('event-queue-') && f.endsWith('.jsonl'));
        } catch {
            return 0;
        }

        for (const file of files) {
            if (file === `event-queue-${activeInstanceId}.jsonl`) continue;

            log.info(`Recovering orphaned queue file: ${file}`);
            const orphanPath = path.join(globalStoragePath, file);

            let content: string;
            try {
                content = fs.readFileSync(orphanPath, 'utf8');
            } catch {
                continue;
            }

            const lines = content.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    await processEvent(event);
                    totalRecovered++;
                } catch { /* skip corrupt/duplicate */ }
            }

            try {
                fs.unlinkSync(orphanPath);
            } catch { /* ignore */ }
        }

        return totalRecovered;
    }
}
