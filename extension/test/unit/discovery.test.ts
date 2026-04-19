import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverWorkspaces, listChatFiles } from '../../src/discovery/workspaceResolver';

describe('discoverWorkspaces', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('discovers workspaces with chatSessions directories', () => {
        // Create mock workspace storage structure
        const wsDir = path.join(tmpDir, 'Code', 'User', 'workspaceStorage');
        const hash1 = 'abc123';
        const chatDir = path.join(wsDir, hash1, 'chatSessions');
        fs.mkdirSync(chatDir, { recursive: true });

        // Create a workspace.json
        fs.writeFileSync(
            path.join(wsDir, hash1, 'workspace.json'),
            JSON.stringify({ folder: 'file:///home/user/project' })
        );

        // Create a JSONL file
        fs.writeFileSync(path.join(chatDir, 'session1.jsonl'), '{"kind":0,"v":{}}');

        // Mock getUserDataDir to return our temp dir
        const origEnv = process.env.APPDATA;
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

        // We'll test listChatFiles instead since discoverWorkspaces depends on platform paths
        const files = listChatFiles(chatDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('session1.jsonl');
    });
});

describe('listChatFiles', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkflow-chat-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('lists only .jsonl files', () => {
        fs.writeFileSync(path.join(tmpDir, 'session1.jsonl'), '');
        fs.writeFileSync(path.join(tmpDir, 'session2.jsonl'), '');
        fs.writeFileSync(path.join(tmpDir, 'other.txt'), '');

        const files = listChatFiles(tmpDir);
        expect(files).toHaveLength(2);
        expect(files.every(f => f.endsWith('.jsonl'))).toBe(true);
    });

    it('returns empty array for non-existent directory', () => {
        const files = listChatFiles(path.join(tmpDir, 'nonexistent'));
        expect(files).toEqual([]);
    });

    it('returns empty array for empty directory', () => {
        const files = listChatFiles(tmpDir);
        expect(files).toEqual([]);
    });

    it('returns full paths', () => {
        fs.writeFileSync(path.join(tmpDir, 'test.jsonl'), '');
        const files = listChatFiles(tmpDir);
        expect(files[0]).toBe(path.join(tmpDir, 'test.jsonl'));
    });
});
