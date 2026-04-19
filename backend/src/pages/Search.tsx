import { useEffect, useState, useCallback } from 'react';
import { api, type SearchResult, type FiltersResponse } from '../lib/api';
import { Link } from 'react-router-dom';
import {
    Search as SearchIcon, Filter, X, ChevronDown, ChevronRight,
    MessageSquare, FolderOpen, User, Clock, Wrench, Brain, FileEdit,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Search() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [filters, setFilters] = useState<FiltersResponse | null>(null);
    const [showFilters, setShowFilters] = useState(false);

    // Active filters
    const [userId, setUserId] = useState('');
    const [workspaceId, setWorkspaceId] = useState('');
    const [modelId, setModelId] = useState('');
    const [agentId, setAgentId] = useState('');
    const [kind, setKind] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    const activeFilterCount = [userId, workspaceId, modelId, agentId, kind, dateFrom, dateTo]
        .filter(Boolean).length;

    // Load filter options
    useEffect(() => {
        api.getFilters().then(setFilters).catch(console.error);
    }, []);

    const doSearch = useCallback(async () => {
        setLoading(true);
        try {
            const params: Record<string, string> = { limit: '100' };
            if (query) params.q = query;
            if (userId) params.user_id = userId;
            if (workspaceId) params.workspace_id = workspaceId;
            if (modelId) params.model_id = modelId;
            if (agentId) params.agent_id = agentId;
            if (kind) params.kind = kind;
            if (dateFrom) params.date_from = dateFrom;
            if (dateTo) params.date_to = dateTo;

            const data = await api.search(params);
            setResults(data.results);
            setTotal(data.total);
        } finally {
            setLoading(false);
        }
    }, [query, userId, workspaceId, modelId, agentId, kind, dateFrom, dateTo]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') doSearch();
    };

    const clearFilters = () => {
        setUserId('');
        setWorkspaceId('');
        setModelId('');
        setAgentId('');
        setKind('');
        setDateFrom('');
        setDateTo('');
    };

    return (
        <div className="p-8 max-w-6xl mx-auto space-y-6">
            {/* Header */}
            <div>
                <h2 className="text-2xl font-bold text-white">Search</h2>
                <p className="text-sm text-gray-500 mt-1">Search across all conversations, turns, and parts</p>
            </div>

            {/* Search Bar */}
            <div className="flex gap-3">
                <div className="relative flex-1">
                    <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search user messages, AI responses, tool outputs, file content..."
                        className="w-full pl-10 pr-4 py-3 rounded-xl bg-gray-900 border border-gray-700 text-sm text-gray-200 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                    />
                </div>
                <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={`px-4 py-3 rounded-xl border text-sm font-medium flex items-center gap-2 ${showFilters || activeFilterCount > 0
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
                <button
                    onClick={doSearch}
                    className="px-6 py-3 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
                >
                    Search
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

                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {/* User */}
                        <FilterSelect
                            label="User"
                            value={userId}
                            onChange={setUserId}
                            options={filters.users.map(u => ({
                                value: String(u.id),
                                label: u.display_name || u.user_uid,
                                detail: `${u.session_count} sessions`,
                            }))}
                        />

                        {/* Workspace */}
                        <FilterSelect
                            label="Workspace"
                            value={workspaceId}
                            onChange={setWorkspaceId}
                            options={filters.workspaces.map(w => ({
                                value: String(w.id),
                                label: extractProjectName(w.folder_uri) || w.display_name || `#${w.id}`,
                            }))}
                        />

                        {/* Model */}
                        <FilterSelect
                            label="Model"
                            value={modelId}
                            onChange={setModelId}
                            options={filters.models.map(m => ({
                                value: m.model_id,
                                label: m.model_id.split('/').pop() || m.model_id,
                                detail: `${m.count} turns`,
                            }))}
                        />

                        {/* Agent */}
                        <FilterSelect
                            label="Agent"
                            value={agentId}
                            onChange={setAgentId}
                            options={filters.agents.map(a => ({
                                value: a.agent_id,
                                label: a.agent_id,
                                detail: `${a.count} turns`,
                            }))}
                        />

                        {/* Part Kind */}
                        <FilterSelect
                            label="Part Kind"
                            value={kind}
                            onChange={setKind}
                            options={filters.kinds.filter(k => k.kind).map(k => ({
                                value: k.kind!,
                                label: kindLabel(k.kind!),
                                detail: `${Number(k.count).toLocaleString()}`,
                            }))}
                        />

                        {/* Date From */}
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">Date From</label>
                            <input
                                type="date"
                                value={dateFrom}
                                onChange={(e) => setDateFrom(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>

                        {/* Date To */}
                        <div>
                            <label className="block text-xs text-gray-500 mb-1.5">Date To</label>
                            <input
                                type="date"
                                value={dateTo}
                                onChange={(e) => setDateTo(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Results */}
            {loading ? (
                <div className="space-y-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-20 shimmer rounded-xl" />
                    ))}
                </div>
            ) : results.length > 0 ? (
                <div className="space-y-6">
                    <p className="text-sm text-gray-500">{total.toLocaleString()} results</p>
                    <div className="space-y-2">
                        {results.map((r, idx) => (
                            <SearchResultCard key={idx} result={r} query={query} />
                        ))}
                    </div>
                </div>
            ) : total === 0 && (query || activeFilterCount > 0) ? (
                <div className="text-center py-16 text-gray-500">
                    <SearchIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>No results found</p>
                    <p className="text-xs mt-1">Try adjusting your search or filters</p>
                </div>
            ) : null}
        </div>
    );
}

function FilterSelect({
    label, value, onChange, options,
}: {
    label: string;
    value: string;
    onChange: (val: string) => void;
    options: { value: string; label: string; detail?: string }[];
}) {
    return (
        <div>
            <label className="block text-xs text-gray-500 mb-1.5">{label}</label>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:border-indigo-500 focus:outline-none"
            >
                <option value="">All</option>
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>
                        {opt.label}{opt.detail ? ` (${opt.detail})` : ''}
                    </option>
                ))}
            </select>
        </div>
    );
}

function SearchResultCard({ result, query }: { result: SearchResult; query: string }) {
    const title = result.custom_title || result.title || 'Untitled Session';
    const project = extractProjectName(result.folder_uri);
    const modified = result.last_modified_at
        ? formatDistanceToNow(new Date(result.last_modified_at), { addSuffix: true })
        : '';

    return (
        <Link
            to={`/sessions/${result.session_uuid}`}
            className="block rounded-xl border border-gray-800 bg-gray-900/50 p-4 hover:border-gray-700 hover:bg-gray-900/80 group"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-gray-200 group-hover:text-white truncate">{title}</h3>
                        <span className="text-xs text-indigo-400 flex-shrink-0">Turn {result.turn_index}</span>
                    </div>

                    {/* User message preview */}
                    <p className="text-xs text-gray-400 line-clamp-1 mb-1">
                        <User className="w-3 h-3 inline mr-1" />
                        {result.user_text || '(empty)'}
                    </p>

                    {/* Matched content */}
                    {result.matched_content && (
                        <p className="text-xs text-gray-500 line-clamp-1">
                            <span className="text-gray-600">[{kindLabel(result.matched_kind || '')}]</span>{' '}
                            <HighlightText text={result.matched_content} query={query} />
                        </p>
                    )}

                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
                        {project && (
                            <span className="flex items-center gap-1">
                                <FolderOpen className="w-3 h-3" />
                                {project}
                            </span>
                        )}
                        {result.user_display_name && (
                            <span className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {result.user_display_name}
                            </span>
                        )}
                        {modified && (
                            <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {modified}
                            </span>
                        )}
                        {result.model_id && (
                            <span className="font-mono">{result.model_id.split('/').pop()}</span>
                        )}
                    </div>
                </div>
            </div>
        </Link>
    );
}

function HighlightText({ text, query }: { text: string; query: string }) {
    if (!query) return <>{text}</>;

    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return <>{text}</>;

    return (
        <>
            {text.slice(0, idx)}
            <span className="bg-indigo-500/30 text-indigo-300 px-0.5 rounded">{text.slice(idx, idx + query.length)}</span>
            {text.slice(idx + query.length)}
        </>
    );
}

function kindLabel(kind: string): string {
    const labels: Record<string, string> = {
        '': 'Text',
        thinking: 'Thinking',
        toolInvocationSerialized: 'Tool Call',
        textEditGroup: 'File Edit',
        inlineReference: 'Reference',
        codeblockUri: 'Code Block',
        undoStop: 'Undo',
        mcpServersStarting: 'MCP',
        progressMessage: 'Progress',
        elicitationSerialized: 'Elicitation',
        confirmation: 'Confirmation',
        warning: 'Warning',
        command: 'Command',
        questionCarousel: 'Questions',
    };
    return labels[kind] || kind;
}

function extractProjectName(uri: string | null): string {
    if (!uri) return '';
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}
