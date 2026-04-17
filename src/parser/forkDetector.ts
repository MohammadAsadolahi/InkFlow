import type { JsonlEntry } from '../types';

export interface ForkEvent {
    /** Index where the fork truncates (i value) */
    forkAt: number;
    /** New items pushed after truncation */
    newItems: unknown[];
    /** Previous turn count before fork */
    previousTurnCount: number;
}

/**
 * Detect if a JSONL entry represents a fork operation.
 *
 * ALL FIVE conditions must hold:
 * 1. kind === 2
 * 2. k.length === 1
 * 3. k[0] === "requests"
 * 4. i !== undefined
 * 5. i < currentTurnCount
 *
 * Missing any one produces false positives:
 * - Without k.length===1: streaming response updates (k=["requests",0,"response"]) false-positive
 * - Without i<currentTurnCount: pure appends (i===currentTurnCount) false-positive
 */
export function detectFork(entry: JsonlEntry, currentTurnCount: number): ForkEvent | null {
    // Condition 1: must be kind=2 (push/truncate)
    if (entry.kind !== 2) return null;

    // Condition 2: key path must have exactly 1 element
    if (!entry.k || entry.k.length !== 1) return null;

    // Condition 3: key must be "requests"
    if (entry.k[0] !== 'requests') return null;

    // Condition 4: i must be defined (truncation is happening)
    if (entry.i === undefined) return null;

    // Condition 5: i must be LESS than current turn count (actual truncation, not append)
    if (entry.i >= currentTurnCount) return null;

    return {
        forkAt: entry.i,
        newItems: entry.v ?? [],
        previousTurnCount: currentTurnCount,
    };
}
