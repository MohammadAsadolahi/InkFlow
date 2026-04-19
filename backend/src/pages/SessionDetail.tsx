import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, type SessionDetail as SessionDetailType, type Turn } from '../lib/api';
import TurnView from '../components/TurnView';
import {
    ArrowLeft, Clock, Layers, GitFork, Brain, Wrench,
    FileEdit, Type, MessageSquare, Puzzle,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

export default function SessionDetail() {
    const { id } = useParams<{ id: string }>();
    const [session, setSession] = useState<SessionDetailType | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());

    useEffect(() => {
        if (!id) return;
        setLoading(true);
        Promise.all([
            api.getSession(id),
            api.getTurns(id),
        ]).then(([sessionData, turnsData]) => {
            setSession(sessionData);
            setTurns(turnsData.turns);
            // Auto-expand all turns
            setExpandedTurns(new Set(turnsData.turns.map(t => t.turn_index)));
        }).finally(() => setLoading(false));
    }, [id]);

    const toggleTurn = (idx: number) => {
        setExpandedTurns(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    };

    const expandAll = () => setExpandedTurns(new Set(turns.map(t => t.turn_index)));
    const collapseAll = () => setExpandedTurns(new Set());

    if (loading) {
        return (
            <div className="p-8 max-w-5xl mx-auto space-y-4">
                <div className="h-8 w-64 shimmer rounded" />
                <div className="h-24 shimmer rounded-xl" />
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-32 shimmer rounded-xl" />
                ))}
            </div>
        );
    }

    if (!session) {
        return (
            <div className="p-8 text-center text-gray-500">
                <p>Session not found</p>
                <Link to="/sessions" className="text-indigo-400 hover:underline mt-2 inline-block">Back to sessions</Link>
            </div>
        );
    }

    const s = session.session;
    const title = s.custom_title || s.title || 'Untitled Session';
    const projectName = extractProjectName(s.folder_uri);
    const stats = session.partStats;

    const getKindCount = (kind: string | null) =>
        parseInt(stats.find(k => k.kind === kind)?.count || '0');

    return (
        <div className="p-8 max-w-5xl mx-auto space-y-6">
            {/* Back + Header */}
            <Link
                to="/sessions"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300"
            >
                <ArrowLeft className="w-4 h-4" />
                Back to Sessions
            </Link>

            {/* Session Header Card */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                <h2 className="text-xl font-bold text-white mb-1">{title}</h2>
                {projectName && (
                    <p className="text-sm text-gray-500 mb-4">{projectName}</p>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 text-center">
                    <StatBadge icon={MessageSquare} label="Turns" value={turns.length} color="text-blue-400" />
                    <StatBadge icon={Type} label="Text" value={getKindCount(null)} color="text-purple-400" />
                    <StatBadge icon={Brain} label="Thinking" value={getKindCount('thinking')} color="text-violet-400" />
                    <StatBadge icon={Wrench} label="Tool Calls" value={getKindCount('toolInvocationSerialized')} color="text-amber-400" />
                    <StatBadge icon={FileEdit} label="File Edits" value={getKindCount('textEditGroup')} color="text-emerald-400" />
                    <StatBadge icon={Puzzle} label="References" value={getKindCount('inlineReference')} color="text-cyan-400" />
                </div>

                <div className="flex items-center gap-4 mt-4 text-xs text-gray-500 flex-wrap">
                    <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Modified {formatDistanceToNow(new Date(s.last_modified_at), { addSuffix: true })}
                    </span>
                    {s.created_at && (
                        <span className="flex items-center gap-1">
                            Created {format(new Date(s.created_at), 'PPP p')}
                        </span>
                    )}
                    {s.fork_count > 0 && (
                        <span className="flex items-center gap-1">
                            <GitFork className="w-3 h-3" />
                            {s.fork_count} forks
                        </span>
                    )}
                    {(s.user_display_name || s.user_uid) && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400">
                            User: {s.user_display_name || s.user_uid}
                        </span>
                    )}
                    <span className="text-gray-700 font-mono">{s.session_uuid}</span>
                </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2">
                <button
                    onClick={expandAll}
                    className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white"
                >
                    Expand All
                </button>
                <button
                    onClick={collapseAll}
                    className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-white"
                >
                    Collapse All
                </button>
                <span className="text-xs text-gray-600 ml-2">
                    {turns.reduce((acc, t) => acc + t.parts.length, 0).toLocaleString()} total parts
                </span>
            </div>

            {/* Turns */}
            <div className="space-y-4">
                {turns.map((turn) => (
                    <TurnView
                        key={turn.turn_index}
                        turn={turn}
                        expanded={expandedTurns.has(turn.turn_index)}
                        onToggle={() => toggleTurn(turn.turn_index)}
                    />
                ))}
            </div>
        </div>
    );
}

function StatBadge({
    icon: Icon, label, value, color,
}: {
    icon: typeof MessageSquare; label: string; value: number; color: string;
}) {
    return (
        <div className="flex flex-col items-center">
            <Icon className={`w-4 h-4 ${color} mb-1`} />
            <p className="text-lg font-bold text-gray-200">{value.toLocaleString()}</p>
            <p className="text-xs text-gray-500">{label}</p>
        </div>
    );
}

function extractProjectName(uri: string | null): string {
    if (!uri) return '';
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}
