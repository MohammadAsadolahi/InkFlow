import { useEffect, useState } from 'react';
import { api, type StatsResponse } from '../lib/api';
import { Link } from 'react-router-dom';
import {
    MessageSquare, Layers, Puzzle, Users, FolderOpen,
    TrendingUp, Brain, Wrench, FileEdit, Type,
} from 'lucide-react';

const kindIcons: Record<string, { icon: typeof Brain; color: string; label: string }> = {
    '': { icon: Type, color: 'text-purple-400', label: 'AI Text' },
    thinking: { icon: Brain, color: 'text-violet-400', label: 'Thinking' },
    toolInvocationSerialized: { icon: Wrench, color: 'text-amber-400', label: 'Tool Calls' },
    textEditGroup: { icon: FileEdit, color: 'text-emerald-400', label: 'File Edits' },
    inlineReference: { icon: Puzzle, color: 'text-cyan-400', label: 'References' },
};

export default function Dashboard() {
    const [stats, setStats] = useState<StatsResponse | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api.getStats().then(setStats).finally(() => setLoading(false));
    }, []);

    if (loading) return <DashboardSkeleton />;
    if (!stats) return <div className="p-8 text-red-400">Failed to load stats</div>;

    const { overview, kindStats, recentActivity, topWorkspaces } = stats;

    const statCards = [
        { label: 'Sessions', value: overview.total_sessions, icon: MessageSquare, color: 'text-blue-400', bg: 'bg-blue-500/10' },
        { label: 'Turns', value: overview.total_turns, icon: Layers, color: 'text-indigo-400', bg: 'bg-indigo-500/10' },
        { label: 'Parts', value: overview.total_parts, icon: Puzzle, color: 'text-purple-400', bg: 'bg-purple-500/10' },
        { label: 'Users', value: overview.total_users, icon: Users, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
        { label: 'Workspaces', value: overview.total_workspaces, icon: FolderOpen, color: 'text-amber-400', bg: 'bg-amber-500/10' },
        { label: 'Sessions (24h)', value: overview.sessions_24h, icon: TrendingUp, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
    ];

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            {/* Header */}
            <div>
                <h2 className="text-2xl font-bold text-white">Dashboard</h2>
                <p className="text-sm text-gray-500 mt-1">Overview of all captured AI conversations</p>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {statCards.map(({ label, value, icon: Icon, color, bg }) => (
                    <div key={label} className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
                        <div className={`inline-flex items-center justify-center w-8 h-8 rounded-lg ${bg} mb-3`}>
                            <Icon className={`w-4 h-4 ${color}`} />
                        </div>
                        <p className="text-2xl font-bold text-white">{Number(value).toLocaleString()}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Part Kind Breakdown */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                    <h3 className="text-sm font-semibold text-gray-300 mb-4">Part Kind Distribution</h3>
                    <div className="space-y-2">
                        {kindStats.slice(0, 10).map((ks) => {
                            const total = parseInt(overview.total_parts);
                            const count = parseInt(ks.count);
                            const pct = total > 0 ? (count / total) * 100 : 0;
                            const kindInfo = kindIcons[ks.kind || ''];
                            const label = kindInfo?.label || ks.kind || 'Text';

                            return (
                                <div key={ks.kind ?? '__null__'} className="flex items-center gap-3">
                                    <span className="w-32 text-xs text-gray-400 truncate">{label}</span>
                                    <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-indigo-500 rounded-full"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                    <span className="text-xs text-gray-500 w-16 text-right">{count.toLocaleString()}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Top Workspaces */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                    <h3 className="text-sm font-semibold text-gray-300 mb-4">Top Workspaces</h3>
                    <div className="space-y-3">
                        {topWorkspaces.map((ws) => {
                            const name = ws.display_name || extractProjectName(ws.folder_uri) || 'Unknown';
                            return (
                                <Link
                                    key={ws.id}
                                    to={`/sessions?workspace_id=${ws.id}`}
                                    className="flex items-center justify-between p-3 rounded-lg bg-gray-800/30 hover:bg-gray-800/60 group"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <FolderOpen className="w-4 h-4 text-gray-500 group-hover:text-indigo-400 flex-shrink-0" />
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-gray-200 truncate">{name}</p>
                                            <p className="text-xs text-gray-600">{ws.variant}</p>
                                        </div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <p className="text-sm font-medium text-gray-300">{ws.sessions} sessions</p>
                                        <p className="text-xs text-gray-500">{ws.turns} turns</p>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* Recent Activity */}
            {recentActivity.length > 0 && (
                <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
                    <h3 className="text-sm font-semibold text-gray-300 mb-4">Activity (Last 30 Days)</h3>
                    <div className="flex items-end gap-1 h-32">
                        {recentActivity.slice().reverse().map((day) => {
                            const maxTurns = Math.max(...recentActivity.map(d => parseInt(d.turns)));
                            const height = maxTurns > 0 ? (parseInt(day.turns) / maxTurns) * 100 : 0;
                            return (
                                <div
                                    key={day.day}
                                    className="flex-1 bg-indigo-500/60 rounded-t hover:bg-indigo-400/60 transition-colors relative group"
                                    style={{ height: `${Math.max(height, 2)}%` }}
                                    title={`${day.day}: ${day.sessions} sessions, ${day.turns} turns`}
                                >
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-gray-800 text-xs text-gray-200 px-2 py-1 rounded whitespace-nowrap z-10">
                                        {day.day}: {day.turns} turns
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="flex justify-between mt-2">
                        <span className="text-xs text-gray-600">30 days ago</span>
                        <span className="text-xs text-gray-600">Today</span>
                    </div>
                </div>
            )}
        </div>
    );
}

function extractProjectName(uri: string | null): string {
    if (!uri) return '';
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

function DashboardSkeleton() {
    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            <div className="h-8 w-48 shimmer rounded" />
            <div className="grid grid-cols-6 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-24 shimmer rounded-xl" />
                ))}
            </div>
            <div className="grid grid-cols-2 gap-6">
                <div className="h-64 shimmer rounded-xl" />
                <div className="h-64 shimmer rounded-xl" />
            </div>
        </div>
    );
}
