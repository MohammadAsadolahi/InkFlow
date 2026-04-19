import type { VscodeVariant } from '../types';
import * as path from 'path';

interface VariantConfig {
    variant: VscodeVariant;
    /** Relative path from user data dir to workspaceStorage */
    relPath: string;
}

const VARIANT_CONFIGS: VariantConfig[] = [
    { variant: 'stable', relPath: path.join('Code', 'User', 'workspaceStorage') },
    { variant: 'insiders', relPath: path.join('Code - Insiders', 'User', 'workspaceStorage') },
    { variant: 'exploration', relPath: path.join('Code - Exploration', 'User', 'workspaceStorage') },
    { variant: 'vscodium', relPath: path.join('VSCodium', 'User', 'workspaceStorage') },
];

/**
 * Get the user data directory for the current platform.
 */
export function getUserDataDir(): string {
    const platform = process.platform;

    if (platform === 'win32') {
        return process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    }
    if (platform === 'darwin') {
        return path.join(process.env.HOME || '', 'Library', 'Application Support');
    }
    // Linux
    return process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
}

/**
 * Get the workspaceStorage directory for a specific VS Code variant.
 */
export function getWorkspaceStorageDir(variant: VscodeVariant): string {
    const config = VARIANT_CONFIGS.find(c => c.variant === variant);
    if (!config) {
        throw new Error(`Unknown variant: ${variant}`);
    }
    return path.join(getUserDataDir(), config.relPath);
}

/**
 * Get the chatSessions directory for a specific workspace hash.
 * Since ~VS Code 1.109, chatSessions/ is at the workspace storage root level.
 */
export function getChatSessionsDir(workspaceStorageDir: string, storageHash: string): string {
    return path.join(workspaceStorageDir, storageHash, 'chatSessions');
}

/**
 * Check if a path is a UNC network path (Windows).
 * fs.watch is unreliable on UNC paths.
 */
export function isUncPath(p: string): boolean {
    return p.startsWith('\\\\') || p.startsWith('//');
}

/**
 * Get all workspaceStorage directories for the specified variants.
 */
export function getVariantStorageDirs(variants: VscodeVariant[]): Array<{ variant: VscodeVariant; dir: string }> {
    return variants.map(variant => ({
        variant,
        dir: getWorkspaceStorageDir(variant),
    }));
}
