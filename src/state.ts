import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.GMAIL_MCP_STATE_DIR?.trim();
    return configured ? path.resolve(configured) : path.join(os.homedir(), '.gmail-mcp');
}

export function ensureStateDirectory(stateDirectory = getStateDirectory()): string {
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDirectory, 0o700);
    return stateDirectory;
}

export function getStateDatabasePath(stateDirectory = getStateDirectory()): string {
    return path.join(stateDirectory, 'state.sqlite3');
}
