import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-stdio-test-'));
const child = spawn(process.execPath, ['dist/index.js', '--tool-prefix=stdio_'], {
    cwd: process.cwd(),
    env: {
        ...process.env,
        GMAIL_MCP_STATE_DIR: stateDirectory,
        GMAIL_OAUTH_PATH: path.join(stateDirectory, 'missing-google-oauth-keys.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

const responses = new Map();
const waiters = new Map();
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        throw new Error(`Non-JSON output on MCP stdout: ${line}`);
    }
    if (message.id === undefined) return;
    const waiter = waiters.get(message.id);
    if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
    } else {
        responses.set(message.id, message);
    }
});

function request(id, method, params = {}) {
    const existing = responses.get(id);
    if (existing) {
        responses.delete(id);
        return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            waiters.delete(id);
            reject(new Error(`Timed out waiting for stdio response ${id}.\n${stderr}`));
        }, 10_000);
        waiters.set(id, {
            resolve: message => {
                clearTimeout(timeout);
                resolve(message);
            },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

try {
    const initialize = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gmail-mcp-stdio-test', version: '1.0.0' },
    });
    assert.equal(initialize.result.serverInfo.name, 'gmail');
    assert.equal(initialize.result.serverInfo.version, '2.0.0');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listTools = await request(2, 'tools/list');
    assert.ok(listTools.result.tools.some(tool => tool.name === 'stdio_list_accounts'));
    assert.ok(!listTools.result.tools.some(tool => tool.name === 'list_accounts'));
    const listAccounts = await request(3, 'tools/call', {
        name: 'stdio_list_accounts',
        arguments: {},
    });
    assert.match(listAccounts.result.content[0].text, /"accounts"/);
    const hiddenUnprefixedCall = await request(4, 'tools/call', {
        name: 'list_accounts',
        arguments: {},
    });
    assert.equal(hiddenUnprefixedCall.result.isError, true);
    assert.match(hiddenUnprefixedCall.result.content[0].text, /not found/);
    console.log('Stdio server process test passed.');
} finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    lines.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
}
