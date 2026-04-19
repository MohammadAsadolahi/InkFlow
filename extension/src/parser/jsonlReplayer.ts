import type { JsonlEntry } from '../types';

/**
 * Navigate to a nested path inside an object, creating intermediate objects/arrays as needed.
 * Returns the parent container of the final key.
 */
function navigateTo(root: any, path: (string | number)[]): any {
    let current = root;
    for (const key of path) {
        if (current[key] === undefined || current[key] === null) {
            // Peek ahead: if key is a number, create an array; otherwise an object
            current[key] = {};
        }
        current = current[key];
    }
    return current;
}

/**
 * Apply a single JSONL patch entry to the current state.
 *
 * Verified against VS Code source: objectMutationLog.ts
 * - kind=0: Full state replacement
 * - kind=1: Set value at nested path
 * - kind=2: Truncate array to length `i`, then push `v` items. `v` and `i` COEXIST.
 * - kind=3: Delete property at path
 */
export function applyPatch(state: any, entry: JsonlEntry): any {
    if (entry.kind === 0) {
        return structuredClone(entry.v);
    }

    const path = entry.k;
    if (!path || path.length === 0) {
        return state;
    }

    const parent = navigateTo(state, path.slice(0, -1));
    const lastKey = path[path.length - 1];

    switch (entry.kind) {
        case 1: // Set
            parent[lastKey] = entry.v;
            break;

        case 2: { // Truncate-then-push
            let arr = parent[lastKey];
            if (!Array.isArray(arr)) {
                arr = [];
                parent[lastKey] = arr;
            }
            if (entry.i !== undefined) {
                arr.length = entry.i;
            }
            if (entry.v && Array.isArray(entry.v)) {
                arr.push(...entry.v);
            }
            break;
        }

        case 3: // Delete
            delete parent[lastKey];
            break;
    }

    return state;
}

/**
 * Stateful JSONL replayer. Feed it lines one at a time, get current state back.
 */
export class JsonlReplayer {
    private state: any = null;
    private lineCount = 0;

    /** Apply one parsed entry and return the new state */
    apply(entry: JsonlEntry): any {
        this.state = applyPatch(this.state, entry);
        this.lineCount++;
        return this.state;
    }

    /** Get current replayed state */
    getState(): any {
        return this.state;
    }

    /** Get number of lines processed */
    getLineCount(): number {
        return this.lineCount;
    }

    /** Reset state (e.g., on file rewrite) */
    reset(): void {
        this.state = null;
        this.lineCount = 0;
    }

    /**
     * Replay an array of entries (e.g., reading an entire file).
     * Returns the final state.
     */
    replayAll(entries: JsonlEntry[]): any {
        for (const entry of entries) {
            this.apply(entry);
        }
        return this.state;
    }
}

/**
 * Parse a raw JSONL line into a JsonlEntry.
 * Returns null if the line is empty or unparseable.
 */
export function parseJsonlLine(line: string): JsonlEntry | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) return null;
        if (typeof parsed.kind !== 'number') return null;
        if (parsed.kind < 0 || parsed.kind > 3) return null;
        return parsed as JsonlEntry;
    } catch {
        return null;
    }
}
