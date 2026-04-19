import { Outlet, NavLink } from 'react-router-dom';
import { LayoutDashboard, MessageSquare, Search, Sparkles, Users } from 'lucide-react';

const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/sessions', icon: MessageSquare, label: 'Sessions' },
    { to: '/search', icon: Search, label: 'Search' },
    { to: '/users', icon: Users, label: 'Users' },
];

export default function Layout() {
    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="w-64 flex-shrink-0 border-r border-gray-800 bg-gray-950 flex flex-col">
                {/* Logo */}
                <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-800">
                    <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-600">
                        <Sparkles className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-white tracking-tight">InkFlow</h1>
                        <p className="text-xs text-gray-500 -mt-0.5">AI Conversation Intelligence</p>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 py-4 space-y-1">
                    {navItems.map(({ to, icon: Icon, label }) => (
                        <NavLink
                            key={to}
                            to={to}
                            end={to === '/'}
                            className={({ isActive }) =>
                                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${isActive
                                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                                    : 'text-gray-400 hover:text-white hover:bg-gray-800/50 border border-transparent'
                                }`
                            }
                        >
                            <Icon className="w-4.5 h-4.5" />
                            {label}
                        </NavLink>
                    ))}
                </nav>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-gray-800">
                    <p className="text-xs text-gray-600">v0.1.0</p>
                </div>
            </aside>

            {/* Main content */}
            <main className="flex-1 overflow-y-auto bg-gray-950">
                <Outlet />
            </main>
        </div>
    );
}
