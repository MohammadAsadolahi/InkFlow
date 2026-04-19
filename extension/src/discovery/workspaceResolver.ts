import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveredWorkspace, VscodeVariant } from '../types';
import { getVariantStorageDirs, getChatSessionsDir } from './storageLocator';

/**
 * Discover all workspace hashes that have chatSessions directories
 * for the given VS Code variants.
 */
export function discoverWorkspaces(variants: VscodeVariant[]): DiscoveredWorkspace[] {
    const results: DiscoveredWorkspace[] = [];
    const variantDirs = getVariantStorageDirs(variants);

    for (const { variant, dir: workspaceStorageDir } of variantDirs) {
        let entries: string[];
        try {
            entries = fs.readdirSync(workspaceStorageDir);
        } catch {
            // Directory doesn't exist for this variant — skip
            continue;
        }

        for (const entry of entries) {
            const chatDir = getChatSessionsDir(workspaceStorageDir, entry);
            try {
                const stat = fs.statSync(chatDir);
                if (!stat.isDirectory()) continue;
            } catch {
                continue; // No chatSessions dir
            }

            // Try to read workspace.json for display name / folder URI
            const workspaceJson = path.join(workspaceStorageDir, entry, 'workspace.json');
            let folderUri: string | undefined;
            let displayName: string | undefined;

            try {
                const content = fs.readFileSync(workspaceJson, 'utf8');
                const parsed = JSON.parse(content);
                if (parsed.folder) {
                    folderUri = parsed.folder;
                    // Extract last path segment as display name
                    try {
                        const url = new URL(parsed.folder);
                        displayName = path.basename(decodeURIComponent(url.pathname));
                    } catch {
                        displayName = path.basename(parsed.folder);
                    }
                } else if (parsed.workspace) {
                    folderUri = parsed.workspace;
                    displayName = path.basename(parsed.workspace);
                }
            } catch {
                // workspace.json doesn't exist or is unreadable — not critical
            }

            results.push({
                storageHash: entry,
                variant,
                chatSessionsDir: chatDir,
                folderUri,
                displayName,
            });
        }
    }

    return results;
}

/**
 * List all .jsonl files in a chatSessions directory.
 */
export function listChatFiles(chatSessionsDir: string): string[] {
    try {
        return fs.readdirSync(chatSessionsDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(chatSessionsDir, f));
    } catch {
        return [];
    }
}
