const BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(`${BASE}${url}`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || res.statusText);
    }
    return res.json();
}

export interface SessionListResponse {
    sessions: SessionSummary[];
    total: number;
    limit: number;
    offset: number;
}

export interface SessionSummary {
    id: number;
    session_uuid: string;
    title: string | null;
    custom_title: string | null;
    model_info: string | null;
    turn_count: number;
    fork_count: number;
    created_at: string | null;
    last_modified_at: string;
    source_file: string | null;
    user_id: number | null;
    workspace_id: number;
    folder_uri: string | null;
    workspace_name: string | null;
    variant: string | null;
    user_uid: string | null;
    user_display_name: string | null;
    actual_turns: string;
    total_parts: string;
}

export interface SessionDetail {
    session: SessionSummary;
    partStats: { kind: string | null; count: string }[];
}

export interface Turn {
    id: number;
    turn_index: number;
    request_id: string | null;
    response_id: string | null;
    timestamp_ms: string | null;
    completed_at_ms: string | null;
    model_id: string | null;
    agent_id: string | null;
    mode: string | null;
    user_text: string;
    is_fork: boolean;
    parts: TurnPart[];
}

export interface TurnPart {
    partIndex: number;
    kind: string | null;
    content: string | null;
    rawJson: any;
}

export interface TurnsResponse {
    turns: Turn[];
    sessionId: number;
}

export interface StatsResponse {
    overview: {
        total_sessions: string;
        total_turns: string;
        total_parts: string;
        total_users: string;
        total_workspaces: string;
        sessions_24h: string;
        turns_24h: string;
    };
    kindStats: { kind: string | null; count: string }[];
    recentActivity: { day: string; sessions: string; turns: string }[];
    topWorkspaces: {
        id: number;
        folder_uri: string;
        display_name: string | null;
        variant: string;
        sessions: string;
        turns: string;
    }[];
}

export interface SearchResult {
    session_id: number;
    session_uuid: string;
    title: string | null;
    custom_title: string | null;
    last_modified_at: string;
    folder_uri: string | null;
    workspace_name: string | null;
    user_uid: string | null;
    user_display_name: string | null;
    turn_id: number;
    turn_index: number;
    user_text: string;
    model_id: string | null;
    timestamp_ms: string | null;
    matched_kind: string | null;
    matched_content: string | null;
}

export interface SearchResponse {
    results: SearchResult[];
    total: number;
    limit: number;
    offset: number;
}

export interface FiltersResponse {
    workspaces: { id: number; folder_uri: string; display_name: string | null; variant: string }[];
    models: { model_id: string; count: string }[];
    agents: { agent_id: string; count: string }[];
    kinds: { kind: string | null; count: string }[];
    users: { id: number; user_uid: string; display_name: string | null; session_count: string }[];
}

export const api = {
    getSessions: (params: Record<string, string> = {}) => {
        const qs = new URLSearchParams(params).toString();
        return fetchJson<SessionListResponse>(`/sessions?${qs}`);
    },

    getSession: (id: string) =>
        fetchJson<SessionDetail>(`/sessions/${id}`),

    getTurns: (sessionId: string | number) => {
        const param = typeof sessionId === 'number' ? `session_id=${sessionId}` : `session_uuid=${sessionId}`;
        return fetchJson<TurnsResponse>(`/turns?${param}`);
    },

    getStats: () => fetchJson<StatsResponse>('/stats'),

    search: (params: Record<string, string> = {}) => {
        const qs = new URLSearchParams(params).toString();
        return fetchJson<SearchResponse>(`/search?${qs}`);
    },

    getFilters: () => fetchJson<FiltersResponse>('/search/filters'),
};
