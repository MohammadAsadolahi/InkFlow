import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users as UsersIcon, MessageSquare, Layers, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface UserRow {
    id: number;
    user_uid: string;
    display_name: string | null;
    machine_id: string | null;
    first_seen_at: string;
    last_seen_at: string;
    session_count: string;
    turn_count: string;
}

export default function Users() {
    const [users, setUsers] = useState<UserRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/users')
            .then(r => r.json())
            .then(d => setUsers(d.users))
            .finally(() => setLoading(false));
    }, []);

    return (
        <div className="p-8 max-w-5xl mx-auto space-y-6">
            <div>
                <h2 className="text-2xl font-bold text-white">Users</h2>
                <p className="text-sm text-gray-500 mt-1">
                    All users sending data to this InkFlow instance
                </p>
            </div>

            {loading ? (
                <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="h-24 shimmer rounded-xl" />
                    ))}
                </div>
            ) : users.length === 0 ? (
                <div className="text-center py-16 text-gray-500">
                    <UsersIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>No users registered yet</p>
                    <p className="text-xs mt-1">
                        Set <code className="text-indigo-400">inkflow.identity.userId</code> in
                        VS Code settings to register
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {users.map(u => (
                        <Link
                            key={u.id}
                            to={`/sessions?user_id=${u.id}`}
                            className="block rounded-xl border border-gray-800 bg-gray-900/50 p-5 hover:border-gray-700 hover:bg-gray-900/80 group"
                        >
                            <div className="flex items-center justify-between">
                                <div className="min-w-0">
                                    <h3 className="text-base font-semibold text-gray-200 group-hover:text-white">
                                        {u.display_name || u.user_uid}
                                    </h3>
                                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{u.user_uid}</p>
                                    {u.machine_id && (
                                        <p className="text-xs text-gray-600 mt-0.5">Machine: {u.machine_id.slice(0, 12)}…</p>
                                    )}
                                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                                        <span className="flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            Last seen {formatDistanceToNow(new Date(u.last_seen_at), { addSuffix: true })}
                                        </span>
                                        <span>
                                            First seen {formatDistanceToNow(new Date(u.first_seen_at), { addSuffix: true })}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-6 flex-shrink-0">
                                    <div className="text-center">
                                        <p className="text-xl font-bold text-gray-300">{Number(u.session_count).toLocaleString()}</p>
                                        <p className="text-xs text-gray-600">sessions</p>
                                    </div>
                                    <div className="text-center">
                                        <p className="text-xl font-bold text-gray-300">{Number(u.turn_count).toLocaleString()}</p>
                                        <p className="text-xs text-gray-600">turns</p>
                                    </div>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}
