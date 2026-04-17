import * as fs from 'fs';
import * as path from 'path';

export interface WatcherCallbacks {
    onFileChanged: (filePath: string) => void;
    onError?: (dir: string, err: Error) => void;
}

interface Logger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
    debug: (msg: string) => void;
}

/**
 * Bulletproof file watcher for chatSessions directories.
 * Uses Node.js fs.watch with:
 * - Rate limiter for Windows infinite-loop bug (Node.js #61398)
 * - Close-before-replace pattern (no handle leaks)
 * - Debounce timers
 * - isShuttingDown guard
 * - ENOENT tolerance
 */
export class ChatFileWatcher {
    private watchers = new Map<string, fs.FSWatcher>();
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private eventRateLimiter = new Map<string, number[]>();
    private isShuttingDown = false;
    private _debounceMs: number;
    private callbacks: WatcherCallbacks;
    private log: Logger;

    constructor(callbacks: WatcherCallbacks, debounceMs: number, log: Logger) {
        this.callbacks = callbacks;
        this._debounceMs = debounceMs;
        this.log = log;
    }

    get debounceMs(): number {
        return this._debounceMs;
    }

    set debounceMs(value: number) {
        this._debounceMs = value;
    }

    watchDirectory(dir: string): void {
        if (this.isShuttingDown) return;

        // CLOSE existing watcher first (prevent handle leak)
        const existing = this.watchers.get(dir);
        if (existing) {
            existing.close();
            this.watchers.delete(dir);
        }

        try {
            if (!fs.existsSync(dir)) return;
        } catch { return; }

        try {
            const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
                if (this.isShuttingDown) return;
                if (this.detectInfiniteLoop(dir)) return;

                if (!filename) {
                    this.handleNullFilename(dir);
                    return;
                }

                if (!filename.endsWith('.jsonl')) return;

                this.debounce(path.join(dir, filename));
            });

            watcher.on('error', (err) => {
                this.log.warn(`Watcher error: ${dir}: ${err.message}`);
                this.watchers.delete(dir);
                watcher.close();
                this.callbacks.onError?.(dir, err);

                if (!this.isShuttingDown) {
                    setTimeout(() => this.watchDirectory(dir), 5000);
                }
            });

            this.watchers.set(dir, watcher);
            this.log.info(`Watching directory: ${dir}`);
        } catch (err: any) {
            if (err.code === 'ENOENT') return;
            this.log.error(`Failed to watch ${dir}`, err);
        }
    }

    private debounce(filePath: string): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(filePath, setTimeout(() => {
            this.debounceTimers.delete(filePath);
            if (!this.isShuttingDown) {
                this.callbacks.onFileChanged(filePath);
            }
        }, this._debounceMs));
    }

    private detectInfiniteLoop(dir: string): boolean {
        const now = Date.now();
        let timestamps = this.eventRateLimiter.get(dir);
        if (!timestamps) {
            timestamps = [];
            this.eventRateLimiter.set(dir, timestamps);
        }
        timestamps.push(now);

        // Keep only last 5 seconds
        const cutoff = now - 5000;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }

        if (timestamps.length > 500) { // >100/sec for 5s
            this.log.error(`Infinite loop detected for ${dir}, recreating watcher`);
            const w = this.watchers.get(dir);
            if (w) w.close();
            this.watchers.delete(dir);
            this.eventRateLimiter.delete(dir);

            setTimeout(() => this.watchDirectory(dir), 10_000);
            return true;
        }
        return false;
    }

    private handleNullFilename(dir: string): void {
        // filename can be null on some platforms — scan the directory for .jsonl files
        try {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
                this.debounce(path.join(dir, file));
            }
        } catch {
            // Directory might have been deleted
        }
    }

    /** Get all watched directories */
    getWatchedDirectories(): string[] {
        return [...this.watchers.keys()];
    }

    /** Stop watching a specific directory */
    unwatchDirectory(dir: string): void {
        const watcher = this.watchers.get(dir);
        if (watcher) {
            watcher.close();
            this.watchers.delete(dir);
        }
    }

    dispose(): void {
        this.isShuttingDown = true;

        // Clear all debounce timers
        for (const [, timer] of this.debounceTimers) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        // Close all watchers
        for (const [, watcher] of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();

        // Clear rate limiter
        this.eventRateLimiter.clear();
    }
}
