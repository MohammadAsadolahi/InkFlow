import postgres from 'postgres';
import type { MessageRole, ChangeType } from '../../types';

export class MessageRepo {
    constructor(private sql: postgres.Sql) { }

    async create(
        sessionId: number,
        requestIndex: number,
        role: MessageRole,
        content: string,
        contentHash: Buffer,
        opts?: {
            isFork?: boolean;
            forkSourceId?: number;
            isStreaming?: boolean;
            metadata?: unknown;
        }
    ): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO messages (
                session_id, request_index, role, content, content_hash,
                is_fork, fork_source_id, is_streaming, metadata
            ) VALUES (
                ${sessionId}, ${requestIndex}, ${role}, ${content}, ${contentHash},
                ${opts?.isFork ?? false}, ${opts?.forkSourceId ?? null},
                ${opts?.isStreaming ?? false}, ${opts?.metadata ? JSON.stringify(opts.metadata) : null}
            )
            RETURNING id
        `;
        return row.id;
    }

    async addVersion(
        messageId: number,
        version: number,
        content: string,
        contentHash: Buffer,
        changeType: ChangeType,
        rawEventId?: number,
    ): Promise<number> {
        const [row] = await this.sql`
            INSERT INTO message_versions (message_id, version, content, content_hash, change_type, raw_event_id)
            VALUES (${messageId}, ${version}, ${content}, ${contentHash}, ${changeType}, ${rawEventId ?? null})
            RETURNING id
        `;
        return row.id;
    }

    async finalize(messageId: number, finalContent: string, contentHash: Buffer): Promise<void> {
        await this.sql`
            UPDATE messages
            SET content = ${finalContent}, content_hash = ${contentHash},
                is_streaming = FALSE, finalized_at = NOW()
            WHERE id = ${messageId}
        `;
    }

    async softDelete(messageId: number, reason: string): Promise<void> {
        await this.sql`
            UPDATE messages
            SET deleted_at = NOW(), deletion_reason = ${reason}
            WHERE id = ${messageId}
        `;
    }

    async softDeleteFromIndex(sessionId: number, fromIndex: number, reason: string): Promise<postgres.Row[]> {
        return await this.sql`
            UPDATE messages
            SET deleted_at = NOW(), deletion_reason = ${reason}
            WHERE session_id = ${sessionId}
              AND request_index >= ${fromIndex}
              AND deleted_at IS NULL
            RETURNING id, request_index
        `;
    }

    async getActiveBySession(sessionId: number) {
        return await this.sql`
            SELECT * FROM messages
            WHERE session_id = ${sessionId} AND deleted_at IS NULL
            ORDER BY request_index ASC
        `;
    }

    async getBySessionAndIndex(sessionId: number, requestIndex: number) {
        const [row] = await this.sql`
            SELECT * FROM messages
            WHERE session_id = ${sessionId}
              AND request_index = ${requestIndex}
              AND deleted_at IS NULL
        `;
        return row ?? null;
    }

    async getVersionCount(messageId: number): Promise<number> {
        const [row] = await this.sql`
            SELECT COALESCE(MAX(version), 0) AS max_version
            FROM message_versions
            WHERE message_id = ${messageId}
        `;
        return row.max_version;
    }
}
