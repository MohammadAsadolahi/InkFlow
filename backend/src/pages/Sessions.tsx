import { useEffect, useState, useCallback } from 'react';
import { api, type SessionSummary, type FiltersResponse } from '../lib/api';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquare, Clock, Layers, ChevronLeft, ChevronRight, FolderOpen, User, Filter, X, Calendar } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Sessions() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState<FiltersResponse | null>(null);
    const [showFilters, setShowFilters] = useState(false);

    const page = parseInt(searchParams.get('page') || '1');
    const limit = 25;
    const offset = (page - 1) * limit;
    const search = searchParams.get('search') || '';
    const workspaceId = searchParams.get('workspace_id') || '';
    const userId = searchParams.get('user_id') || '';
    const dateFrom = searchParams.get('date_from') || '';
    const dateTo = searchParams.get('date_to') || '';
    const sort = searchParams.get('sort') || 'last_modified_at';
    const order = searchParams.get('order') || 'desc';

    const activeFilterCount = [workspaceId, userId, dateFrom, dateTo].filter(Boolean).length;

    // Load filter options once
    useEffect(() => {
        api.getFilters().then(setFilters).catch(console.error);
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const params: Record<string, string> = {
                limit: String(limit),
                offset: String(offset),
                sort,
                order,
            };
            if (search) params.search = search;
            if (workspaceId) params.workspace_id = workspaceId;
            if (userId) params.user_id = userId;
            if (dateFrom) params.date_from = dateFrom;
            if (dateTo) params.date_to = dateTo;

            const data = await api.getSessions(params);
            setSessions(data.sessions);
            setTotal(data.total);
        } finally {
            setLoading(false);
        }
    }, [offset, search, workspaceId, userId, dateFrom, dateTo, sort, order]);

    useEffect(() => { load(); }, [load]);

    const totalPages = Math.ceil(total / limit);

    const setParam = (key: string, value: string) => {
        const next = new URLSearchParams(searchParams);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== 'page') next.delete('page');
        setSearchParams(next);
    };

    const clearFilters = () => {
        const next = new URLSearchParams(searchParams);
        ['workspace_id', 'user_id', 'date_from', 'date_to', 'page'].forEach(k => next.delete(k));
        setSearchParams(next);
    };

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold text-white">Sessions</h2>
                    <p className="text-sm text-gray-500 mt-1">{total.toLocaleString()} total conversations</p>
                </div>
            </div>

            {/* Filters Bar */}
            <div className="flex items-center gap-3 flex-wrap">
                <input
                    type="text"
                    placeholder="Search sessions, users..."
                    value={search}
                    onChange={(e) => setParam('search', e.target.value)}
                    className="flex-1 min-w-[200px] max-w-md px-4 py-2.5 rounded-lg bg-gray-900 border border-gray-700 text-sm text-gray-200 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                />
                <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={`px-4 py-2.5 rounded-lg border text-sm font-medium flex items-center gap-2 ${showFilters || activeFilterCount > 0
                            ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-400'
                            : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-white'
                        }`}
                >
                    <Filter className="w-4 h-4" />
                    Filters
                    {activeFilterCount > 0 && (
                        <span className="bg-indigo-500 text-white text-xs px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>
                    )}
                </button>
                <select
                    value={sort}
                    onChange={(e) => setParam('sort', e.target.value)}
                    className="px-3 py-2.5 rounded-lg bg-gray-900 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                >
                    <option value="last_modified_at">Last Modified</option>
                    <option value="created_at">Created</option>
                    <option value="turn_count">Turn Count</option>
                    <option value="title">Title</option>
                </select>
                <button
                    onClick={() => setParam('order', order === 'desc' ? 'asc' : 'desc')}
                    className="px-3 py-2.5 rounded-lg bg-gray-900 border border-gray-700 text-sm text-gray-300 hover:bg-gray-800"
                >
                    {order === 'desc' ? '↓ Newest' : '↑ Oldest'}
                </button>
            </div>

            {/* Filter Panel */}
            {showFilters && filters && (
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-gray-300">Filters</h3>
                        {activeFilterCount > 0 && (
                            <button
                                onClick={clearFilters}
                                className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
                            >
                                <X className="w-3 h-3" />
                                Clear all
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">User</label>
                            <select
                                value={userId}
                                onChange={(e) => setParam('user_id', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            >
                                <option value="">All Users</option>
                                {filters.users.map(u => (
                                    <option key={u.id} value={String(u.id)}>
                                        {u.display_name || u.user_uid} ({u.session_count} sessions)
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">Workspace / Project</label>
                            <select
                                value={workspaceId}
                                onChange={(e) => setParam('workspace_id', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            >
                                <option value="">All Projects</option>
                                {filters.workspaces.map(w => (
                                    <option key={w.id} value={String(w.id)}>
                                        {extractProjectName(w.folder_uri) || w.display_name || `#${w.id}`}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">Date From</label>
                            <input
                                type="date"
                                value={dateFrom}
                                onChange={(e) => setParam('date_from', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">Date To</label>
                            <input
                                type="date"
                                value={dateTo}
                                onChange={(e) => setParam('date_to', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Session List */}
            <div className="space-y-2">
                {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="h-20 shimmer rounded-xl" />
                    ))
                ) : sessions.length === 0 ? (
                    <div className="text-center py-16 text-gray-500">
                        <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p>No sessions found</p>
                    </div>
                ) : (
                    sessions.map((session) => (
                        <SessionCard key={session.id} session={session} />
                    ))
                )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                    <p className="text-sm text-gray-500">
                        Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setParam('page', String(page - 1))}
                            disabled={page <= 1}
                            className="p-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm text-gray-400 px-2">
                            Page {page} of {totalPages}
                        </span>
                        <button
                            onClick={() => setParam('page', String(page + 1))}
                            disabled={page >= totalPages}
                            className="p-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function SessionCard({ session }: { session: SessionSummary }) {
    const title = session.custom_title || session.title || 'Untitled Session';
    const projectName = extractProjectName(session.folder_uri);
    const modified = session.last_modified_at
        ? formatDistanceToNow(new Date(session.last_modified_at), { addSuffix: true })
        : '';

    return (
        <Link
            to={`/sessions/${session.session_uuid}`}
            className="block rounded-xl border border-gray-800 bg-gray-900/50 p-4 hover:border-gray-700 hover:bg-gray-900/80 group"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-gray-200 group-hover:text-white truncate">
                        {title}
                    </h3>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                        {projectName && (
                            <span className="flex items-center gap-1">
                                <FolderOpen className="w-3 h-3" />
                                {projectName}
                            </span>
                        )}
                        {session.user_display_name && (
                            <span className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {session.user_display_name}
                            </span>
                        )}
                        <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {modified}
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0 text-xs">
                    <div className="text-center">
                        <p className="text-lg font-bold text-gray-300">{session.actual_turns || session.turn_count}</p>
                        <p className="text-gray-600">turns</p>
                    </div>
                    <div className="text-center">
                        <p className="text-lg font-bold text-gray-300">{Number(session.total_parts || 0).toLocaleString()}</p>
                        <p className="text-gray-600">parts</p>
                    </div>
                </div>
            </div>
        </Link>
    );
}

function extractProjectName(uri: string | null): string {
    if (!uri) return '';
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}
