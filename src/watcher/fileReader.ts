import * as fs from 'fs';
import { parseJsonlLine } from '../parser/jsonlReplayer';
import { shouldFilterEvent } from '../parser/eventFilter';
import { computeEventHash, computeHeaderHash } from '../utils/hash';
import type { JsonlEntry } from '../types';

export interface ParsedLine {
    entry: JsonlEntry;
    rawLine: string;
    byteOffset: number;
    eventHash: Buffer;
}

export interface ReadResult {
    /** Successfully parsed and non-filtered lines */
    lines: ParsedLine[];
    /** Byte offset after the last successfully parsed line (relative to file start) */
    consumedUpTo: number;
    /** SHA-256 of the first line of the file (for rewrite detection) */
    headerHash: Buffer | null;
}

/**
 * Read the first line of a file to compute its header hash.
 * Used as the PRIMARY signal for detecting file rewrites (compaction).
 */
export async function readHeaderHash(filePath: string): Promise<Buffer | null> {
    let fd: fs.promises.FileHandle | null = null;
    try {
        fd = await fs.promises.open(filePath, 'r');
        // Read first 64KB — more than enough for any first line
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        if (bytesRead === 0) return null;

        const text = buf.subarray(0, bytesRead).toString('utf8');
        const newlineIdx = text.indexOf('\n');
        const firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
        if (firstLine.trim() === '') return null;

        return computeHeaderHash(firstLine);
    } catch {
        return null;
    } finally {
        await fd?.close();
    }
}

/**
 * Read new bytes from a JSONL file starting at `startOffset`.
 * Partial-line safe: only consumes bytes up to the last complete, parseable line.
 *
 * @param filePath - Absolute path to the JSONL file
 * @param startOffset - Byte offset to start reading from
 * @param filterInputState - Whether to filter inputState noise events
 */
export async function readNewLines(
    filePath: string,
    startOffset: number,
    filterInputState: boolean,
): Promise<ReadResult> {
    const result: ReadResult = {
        lines: [],
        consumedUpTo: startOffset,
        headerHash: null,
    };

    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(filePath);
    } catch {
        return result;
    }

    if (stat.size <= startOffset) {
        return result;
    }

    let fd: fs.promises.FileHandle | null = null;
    try {
        fd = await fs.promises.open(filePath, 'r');

        // Read header hash if starting from beginning
        if (startOffset === 0) {
            const headerBuf = Buffer.alloc(Math.min(65536, stat.size));
            const { bytesRead: headerBytesRead } = await fd.read(headerBuf, 0, headerBuf.length, 0);
            if (headerBytesRead > 0) {
                const headerText = headerBuf.subarray(0, headerBytesRead).toString('utf8');
                const newlineIdx = headerText.indexOf('\n');
                const firstLine = newlineIdx >= 0 ? headerText.slice(0, newlineIdx) : headerText;
                if (firstLine.trim() !== '') {
                    result.headerHash = computeHeaderHash(firstLine);
                }
            }
        }

        const bytesToRead = stat.size - startOffset;
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fd.read(buffer, 0, bytesToRead, startOffset);

        if (bytesRead === 0) return result;

        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split('\n');

        let consumedBytes = 0;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            const isLastElement = lineIdx === lines.length - 1;
            // Last element from split doesn't have a trailing \n
            const lineBytes = Buffer.byteLength(line, 'utf8') + (isLastElement ? 0 : 1);

            if (line.trim() === '') {
                consumedBytes += lineBytes;
                continue;
            }

            const entry = parseJsonlLine(line);
            if (entry === null) {
                // Could be partial line at EOF — stop consuming
                break;
            }

            // Filter noise events
            if (shouldFilterEvent(entry, filterInputState)) {
                consumedBytes += lineBytes;
                continue;
            }

            const byteOffset = startOffset + consumedBytes;
            const eventHash = computeEventHash(filePath, byteOffset, line);

            result.lines.push({
                entry,
                rawLine: line,
                byteOffset,
                eventHash,
            });

            consumedBytes += lineBytes;
        }

        result.consumedUpTo = startOffset + consumedBytes;
    } finally {
        await fd?.close();
    }

    return result;
}
