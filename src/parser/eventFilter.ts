import type { JsonlEntry } from '../types';

/**
 * Determine if a JSONL entry should be filtered out (not ingested).
 *
 * inputState patches are keystroke noise (~10 events/second) that
 * provide no useful chat content. Filter them by default.
 */
export function shouldFilterEvent(entry: JsonlEntry, filterInputState: boolean): boolean {
    if (!filterInputState) return false;

    // inputState patches: kind=1, k[0]==='inputState'
    if (entry.kind === 1 && entry.k && entry.k.length > 0 && entry.k[0] === 'inputState') {
        return true;
    }

    // Also filter kind=2 on inputState sub-paths
    if (entry.kind === 2 && entry.k && entry.k.length > 0 && entry.k[0] === 'inputState') {
        return true;
    }

    return false;
}
