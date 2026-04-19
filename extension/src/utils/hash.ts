import * as crypto from 'crypto';

/**
 * Compute deterministic event hash: SHA-256(file_path + '\0' + byte_offset + '\0' + raw_line)
 *
 * This ensures:
 * - Same bytes at same offset in same file → same hash → dedup
 * - Different files with identical content → different hash (no cross-session collision)
 * - Different offsets with identical content → different hash
 */
export function computeEventHash(filePath: string, byteOffset: number, rawLine: string): Buffer {
    return crypto.createHash('sha256')
        .update(filePath)
        .update('\0')
        .update(String(byteOffset))
        .update('\0')
        .update(rawLine)
        .digest();
}

/**
 * Compute header hash: SHA-256 of the first line of a JSONL file.
 * Used as the PRIMARY signal for detecting file rewrites (compaction).
 */
export function computeHeaderHash(firstLine: string): Buffer {
    return crypto.createHash('sha256')
        .update(firstLine)
        .digest();
}

/**
 * Compute content hash for message dedup.
 */
export function computeContentHash(content: string): Buffer {
    return crypto.createHash('sha256')
        .update(content)
        .digest();
}
