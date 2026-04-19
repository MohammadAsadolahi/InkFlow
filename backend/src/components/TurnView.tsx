import { useState } from 'react';
import type { Turn, TurnPart } from '../lib/api';
import {
    ChevronDown, ChevronRight, User, Bot, Brain, Wrench,
    FileEdit, Link2, Code, Pause, Server, MessageCircle,
    AlertTriangle, Terminal, HelpCircle, Loader, Eye, EyeOff,
} from 'lucide-react';
import { format } from 'date-fns';

interface TurnViewProps {
    turn: Turn;
    expanded: boolean;
    onToggle: () => void;
}

const kindConfig: Record<string, {
    icon: typeof Brain;
    color: string;
    bg: string;
    label: string;
    borderClass: string;
}> = {
    '': {
        icon: Bot, color: 'text-purple-400', bg: 'bg-purple-500/10',
        label: 'AI Text', borderClass: 'kind-text',
    },
    thinking: {
        icon: Brain, color: 'text-violet-400', bg: 'bg-violet-500/10',
        label: 'Thinking', borderClass: 'kind-thinking',
    },
    toolInvocationSerialized: {
        icon: Wrench, color: 'text-amber-400', bg: 'bg-amber-500/10',
        label: 'Tool Call', borderClass: 'kind-toolInvocationSerialized',
    },
    textEditGroup: {
        icon: FileEdit, color: 'text-emerald-400', bg: 'bg-emerald-500/10',
        label: 'File Edit', borderClass: 'kind-textEditGroup',
    },
    inlineReference: {
        icon: Link2, color: 'text-cyan-400', bg: 'bg-cyan-500/10',
        label: 'Reference', borderClass: 'kind-inlineReference',
    },
    codeblockUri: {
        icon: Code, color: 'text-blue-400', bg: 'bg-blue-500/10',
        label: 'Code Block', borderClass: 'kind-codeblockUri',
    },
    undoStop: {
        icon: Pause, color: 'text-gray-500', bg: 'bg-gray-500/10',
        label: 'Undo Stop', borderClass: 'kind-undoStop',
    },
    mcpServersStarting: {
        icon: Server, color: 'text-gray-500', bg: 'bg-gray-500/10',
        label: 'MCP Server', borderClass: 'kind-mcpServersStarting',
    },
    progressMessage: {
        icon: Loader, color: 'text-gray-400', bg: 'bg-gray-500/10',
        label: 'Progress', borderClass: 'kind-progressMessage',
    },
    progressTaskSerialized: {
        icon: Loader, color: 'text-gray-400', bg: 'bg-gray-500/10',
        label: 'Task Progress', borderClass: 'kind-progressMessage',
    },
    elicitationSerialized: {
        icon: HelpCircle, color: 'text-pink-400', bg: 'bg-pink-500/10',
        label: 'Elicitation', borderClass: 'kind-elicitationSerialized',
    },
    confirmation: {
        icon: MessageCircle, color: 'text-green-400', bg: 'bg-green-500/10',
        label: 'Confirmation', borderClass: 'kind-confirmation',
    },
    warning: {
        icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10',
        label: 'Warning', borderClass: 'kind-warning',
    },
    command: {
        icon: Terminal, color: 'text-purple-400', bg: 'bg-purple-500/10',
        label: 'Command', borderClass: 'kind-command',
    },
    questionCarousel: {
        icon: HelpCircle, color: 'text-orange-400', bg: 'bg-orange-500/10',
        label: 'Questions', borderClass: 'kind-questionCarousel',
    },
};

function getKindConfig(kind: string | null) {
    return kindConfig[kind || ''] || {
        icon: Bot, color: 'text-gray-400', bg: 'bg-gray-500/10',
        label: kind || 'Unknown', borderClass: '',
    };
}

export default function TurnView({ turn, expanded, onToggle }: TurnViewProps) {
    const timestamp = turn.timestamp_ms
        ? format(new Date(parseInt(turn.timestamp_ms)), 'HH:mm:ss')
        : '';
    const duration = turn.timestamp_ms && turn.completed_at_ms
        ? ((parseInt(turn.completed_at_ms) - parseInt(turn.timestamp_ms)) / 1000).toFixed(1)
        : null;

    // Count parts by kind
    const kindCounts = new Map<string, number>();
    for (const p of turn.parts) {
        const k = p.kind || '';
        kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
    }

    return (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
            {/* Turn Header */}
            <button
                onClick={onToggle}
                className="w-full flex items-start gap-3 px-5 py-4 hover:bg-gray-800/30 text-left"
            >
                <div className="flex-shrink-0 mt-0.5">
                    {expanded
                        ? <ChevronDown className="w-4 h-4 text-gray-500" />
                        : <ChevronRight className="w-4 h-4 text-gray-500" />
                    }
                </div>

                {/* User message bubble */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="flex items-center gap-1.5">
                            <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center">
                                <User className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-xs font-semibold text-blue-400">Turn {turn.turn_index}</span>
                        </div>
                        {timestamp && (
                            <span className="text-xs text-gray-600">{timestamp}</span>
                        )}
                        {duration && (
                            <span className="text-xs text-gray-600">({duration}s)</span>
                        )}
                        {turn.model_id && (
                            <span className="text-xs text-gray-600 font-mono">{turn.model_id.split('/').pop()}</span>
                        )}
                        {turn.is_fork && (
                            <span className="text-xs text-amber-500 font-medium">⑂ Fork</span>
                        )}
                    </div>
                    <p className="text-sm text-gray-200 line-clamp-2">{turn.user_text || '(empty)'}</p>

                    {/* Part kind badges */}
                    {!expanded && (
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            {Array.from(kindCounts.entries()).map(([kind, count]) => {
                                const cfg = getKindConfig(kind || null);
                                return (
                                    <span
                                        key={kind}
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${cfg.bg} ${cfg.color}`}
                                    >
                                        <cfg.icon className="w-3 h-3" />
                                        {count}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>

                <span className="text-xs text-gray-600 flex-shrink-0">{turn.parts.length} parts</span>
            </button>

            {/* Expanded Parts */}
            {expanded && (
                <div className="border-t border-gray-800/50">
                    {/* User message - shown prominently when expanded */}
                    {turn.user_text && (
                        <div className="px-5 py-3 bg-blue-950/20 border-l-2 border-blue-500">
                            <div className="flex items-center gap-2 mb-1.5">
                                <div className="w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center">
                                    <User className="w-2.5 h-2.5 text-white" />
                                </div>
                                <span className="text-xs font-semibold text-blue-400">You</span>
                                {timestamp && <span className="text-xs text-gray-600">{timestamp}</span>}
                            </div>
                            <div className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed pl-6">
                                {turn.user_text}
                            </div>
                        </div>
                    )}
                    {/* AI response parts in exact chronological order */}
                    <PartsRenderer parts={turn.parts} />
                </div>
            )}
        </div>
    );
}

function PartsRenderer({ parts }: { parts: TurnPart[] }) {
    const [showRaw, setShowRaw] = useState<number | null>(null);

    // Merge consecutive text parts for readability
    const merged = mergeConsecutiveText(parts);

    return (
        <div className="divide-y divide-gray-800/30">
            {merged.map((item, idx) => {
                if (item.type === 'merged-text') {
                    return (
                        <div key={idx} className="px-5 py-3 border-l-2 kind-text">
                            <div className="flex items-center gap-2 mb-1.5">
                                <Bot className="w-3.5 h-3.5 text-purple-400" />
                                <span className="text-xs font-medium text-purple-400">AI Response</span>
                            </div>
                            <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed pl-5">
                                {item.text}
                            </div>
                        </div>
                    );
                }

                const part = item.part;
                const cfg = getKindConfig(part.kind);
                const isRawOpen = showRaw === part.partIndex;

                return (
                    <div key={part.partIndex} className={`px-5 py-2.5 border-l-2 ${cfg.borderClass}`}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <cfg.icon className={`w-3.5 h-3.5 ${cfg.color}`} />
                                <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                                <span className="text-xs text-gray-700">#{part.partIndex}</span>
                            </div>
                            <button
                                onClick={() => setShowRaw(isRawOpen ? null : part.partIndex)}
                                className="p-1 rounded text-gray-600 hover:text-gray-400"
                                title={isRawOpen ? 'Hide raw JSON' : 'Show raw JSON'}
                            >
                                {isRawOpen ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                        </div>

                        {part.content && (
                            <div className="mt-1 pl-5">
                                <PartContent kind={part.kind} content={part.content} rawJson={part.rawJson} />
                            </div>
                        )}

                        {isRawOpen && (
                            <pre className="mt-2 p-3 rounded-lg bg-gray-950 text-xs text-gray-400 overflow-x-auto max-h-64 border border-gray-800">
                                {JSON.stringify(part.rawJson, null, 2)}
                            </pre>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function PartContent({ kind, content, rawJson }: { kind: string | null; content: string; rawJson: any }) {
    switch (kind) {
        case 'thinking':
            return <p className="text-sm text-violet-300/80 italic whitespace-pre-wrap">{content}</p>;

        case 'toolInvocationSerialized':
            return (
                <div className="flex items-center gap-2">
                    <span className="text-sm text-amber-300">{content}</span>
                    {rawJson?.result && (
                        <span className="text-xs text-gray-600">→ has result</span>
                    )}
                </div>
            );

        case 'textEditGroup':
            return (
                <div>
                    <span className="text-sm text-emerald-300 font-mono">{extractFileName(content)}</span>
                    {rawJson?.edits?.length > 0 && (
                        <span className="text-xs text-gray-600 ml-2">
                            {rawJson.edits.length} edit{rawJson.edits.length !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>
            );

        case 'inlineReference':
            return <code className="text-sm text-cyan-300 bg-cyan-900/20 px-1.5 py-0.5 rounded">{content}</code>;

        case 'codeblockUri':
            return <span className="text-sm text-blue-300 font-mono">{extractFileName(content)}</span>;

        case 'warning':
            return <p className="text-sm text-red-300">{content}</p>;

        case 'confirmation':
            return <p className="text-sm text-green-300">{content}</p>;

        default:
            return <p className="text-sm text-gray-400 whitespace-pre-wrap">{content}</p>;
    }
}

/** Merge consecutive null-kind (text) parts into single blocks */
function mergeConsecutiveText(parts: TurnPart[]): (
    | { type: 'merged-text'; text: string }
    | { type: 'part'; part: TurnPart }
)[] {
    const result: (
        | { type: 'merged-text'; text: string }
        | { type: 'part'; part: TurnPart }
    )[] = [];

    let textBuffer = '';

    for (const part of parts) {
        if (part.kind === null && part.content) {
            textBuffer += part.content;
        } else {
            if (textBuffer) {
                result.push({ type: 'merged-text', text: textBuffer });
                textBuffer = '';
            }
            result.push({ type: 'part', part });
        }
    }

    if (textBuffer) {
        result.push({ type: 'merged-text', text: textBuffer });
    }

    return result;
}

function extractFileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts.slice(-2).join('/');
}
