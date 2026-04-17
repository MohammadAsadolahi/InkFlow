/**
 * JSONL patch entry types — verified against VS Code source:
 * src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts
 */

// --- JSONL Patch Types ---

export interface JsonlInitial {
    kind: 0;
    v: unknown;
}

export interface JsonlSet {
    kind: 1;
    k: (string | number)[];
    v: unknown;
}

export interface JsonlPush {
    kind: 2;
    k: (string | number)[];
    v?: unknown[];
    i?: number;
}

export interface JsonlDelete {
    kind: 3;
    k: (string | number)[];
}

export type JsonlEntry = JsonlInitial | JsonlSet | JsonlPush | JsonlDelete;

// --- Raw Event (pre-DB) ---

export interface RawEventInput {
    eventHash: Buffer;
    workspaceId: number;
    sessionFile: string;
    byteOffset: number;
    kind: number;
    keyPath: string[] | null;
    rawContent: unknown;
    fileMtimeMs: number | null;
    instanceId: string;
    batchId: string | null;
}

// --- Watch State ---

export interface WatchState {
    filePath: string;
    workspaceId: number | null;
    lastByteOffset: number;
    lastFileSize: number;
    lastMtimeMs: number | null;
    headerHash: Buffer | null;
    processedAt: Date;
}

// --- Session ---

export interface SessionRow {
    id: number;
    sessionUuid: string;
    workspaceId: number;
    title: string | null;
    customTitle: string | null;
    modelInfo: string | null;
    createdAt: Date | null;
    lastModifiedAt: Date;
    sourceFile: string | null;
    turnCount: number;
    forkCount: number;
    version: number;
    deletedAt: Date | null;
    deletionReason: string | null;
    lastEventId: number | null;
}

// --- Message ---

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type ChangeType = 'created' | 'streamed' | 'finalized' | 'edited' | 'forked' | 'restored' | 'deleted';
export type SnapshotTrigger = 'periodic' | 'pre_delete' | 'pre_fork' | 'file_rewrite' | 'export' | 'manual';

export interface MessageRow {
    id: number;
    sessionId: number;
    requestIndex: number;
    role: MessageRole;
    content: string;
    contentHash: Buffer | null;
    parentMsgId: number | null;
    forkSourceId: number | null;
    isFork: boolean;
    isStreaming: boolean;
    createdAt: Date;
    finalizedAt: Date | null;
    deletedAt: Date | null;
    deletionReason: string | null;
    metadata: unknown;
}

// --- Workspace ---

export interface WorkspaceRow {
    id: number;
    storageHash: string;
    variant: string;
    folderUri: string | null;
    displayName: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
    deletedAt: Date | null;
}

// --- VS Code Variant ---

export type VscodeVariant = 'stable' | 'insiders' | 'exploration' | 'vscodium';

// --- Discovery ---

export interface DiscoveredWorkspace {
    storageHash: string;
    variant: VscodeVariant;
    chatSessionsDir: string;
    folderUri?: string;
    displayName?: string;
}

// --- Config ---

export interface InkFlowConfig {
    database: {
        host: string;
        port: number;
        name: string;
        user: string;
        ssl: boolean;
    };
    watcher: {
        enabled: boolean;
        debounceMs: number;
        watchVariants: VscodeVariant[];
        periodicScanSeconds: number;
    };
    ingestion: {
        filterInputState: boolean;
    };
    privacy: {
        redactContent: boolean;
    };
    retention: {
        maxAgeDays: number | null;
    };
    export: {
        defaultFormat: 'markdown' | 'html' | 'json';
        includeMetadata: boolean;
        includeForks: boolean;
        includeDeleted: boolean;
    };
}
