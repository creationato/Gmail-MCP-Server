import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const API_KEY = 'process-test-api-key-0123456789abcdef';
const CALLBACK_URL = 'https://claude.ai/api/mcp/auth_callback';
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-process-test-'));
let child;
let childProcessState;

async function assertRemoteModeFailsClosed() {
    const env = { ...process.env, GMAIL_MCP_STATE_DIR: stateDirectory };
    for (const name of [
        'GMAIL_MCP_API_KEY',
        'GMAIL_MCP_PUBLIC_ORIGIN',
        'GMAIL_MCP_PUBLIC_URL',
        'MCP_PUBLIC_URL',
        'GMAIL_MCP_OAUTH_CALLBACKS',
    ]) delete env[name];
    const candidate = spawn(process.execPath, ['dist/index.js', '--http', '--host=127.0.0.1', '--port=65534'], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    candidate.stdout.on('data', chunk => { output += chunk.toString(); });
    candidate.stderr.on('data', chunk => { output += chunk.toString(); });
    const exitCode = await Promise.race([
        new Promise(resolve => candidate.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Unconfigured remote server did not exit.')), 5_000)),
    ]);
    if (candidate.exitCode === null) candidate.kill('SIGKILL');
    assert.notEqual(exitCode, 0);
    assert.match(output, /GMAIL_MCP_API_KEY is required/);
}

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test port.');
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
}

async function waitUntilReady(baseUrl, processState) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (processState.exited) {
            throw new Error(`Remote server exited before becoming ready.\n${processState.output}`);
        }
        try {
            const response = await fetch(`${baseUrl}/readyz`);
            if (response.ok) return;
        } catch {
            // The child has not bound its socket yet.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for remote server.\n${processState.output}`);
}

async function startServer(port, options = {}) {
    const processState = { exited: false, output: '' };
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/index.js', '--http', '--host=127.0.0.1', `--port=${port}`], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            GMAIL_MCP_API_KEY: API_KEY,
            GMAIL_MCP_PUBLIC_ORIGIN: baseUrl,
            GMAIL_MCP_OAUTH_CALLBACKS: CALLBACK_URL,
            GMAIL_MCP_STATE_DIR: stateDirectory,
            GMAIL_OAUTH_PATH: path.join(stateDirectory, 'missing-google-oauth-keys.json'),
            GMAIL_MCP_TOOL_PREFIX: 'remote_',
            ...(options.shutdownTimeoutMs
                ? { GMAIL_MCP_SHUTDOWN_TIMEOUT_MS: String(options.shutdownTimeoutMs) }
                : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { processState.output += chunk.toString(); });
    child.stderr.on('data', chunk => { processState.output += chunk.toString(); });
    child.once('exit', () => { processState.exited = true; });
    childProcessState = processState;
    await waitUntilReady(baseUrl, processState);
    return { baseUrl, processState };
}

async function stopServer(signal = 'SIGTERM', timeoutMs = 3_000) {
    if (!child) return undefined;
    const current = child;
    const processState = childProcessState;
    child = undefined;
    childProcessState = undefined;
    if (current.exitCode !== null) {
        return {
            timedOut: false,
            code: current.exitCode,
            exitCode: current.exitCode,
            output: processState?.output || '',
        };
    }
    if (current.exitCode === null) current.kill(signal);
    const outcome = await Promise.race([
        new Promise(resolve => current.once('exit', code => resolve({ timedOut: false, code }))),
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
    ]);
    if (current.exitCode === null) {
        current.kill('SIGKILL');
        await new Promise(resolve => current.once('exit', resolve));
    }
    return {
        ...outcome,
        exitCode: current.exitCode,
        output: processState?.output || '',
    };
}

async function registerClient(baseUrl) {
    const response = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [CALLBACK_URL], client_name: 'Process test' }),
    });
    assert.equal(response.status, 201);
    return response.json();
}

async function authorize(baseUrl, clientId) {
    const verifier = 'p'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const response = await fetch(`${baseUrl}/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: CALLBACK_URL,
            scope: 'gmail offline_access',
            state: 'process-state',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: `${baseUrl}/mcp`,
            api_key: API_KEY,
        }),
        redirect: 'manual',
    });
    assert.equal(response.status, 302);
    const callback = new URL(response.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'process-state');
    return { code: callback.searchParams.get('code'), verifier };
}

async function exchangeCode(baseUrl, clientId, code, verifier) {
    const response = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            redirect_uri: CALLBACK_URL,
            code_verifier: verifier,
            resource: `${baseUrl}/mcp`,
        }),
    });
    assert.equal(response.status, 200);
    return response.json();
}

async function mcpRequest(baseUrl, accessToken, body) {
    return fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
    });
}

try {
    await assertRemoteModeFailsClosed();
    const port = await reservePort();
    let { baseUrl } = await startServer(port);

    const directKey = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(directKey.status, 401, 'the API key must not bypass OAuth');
    assert.equal((await fetch(`${baseUrl}/mcp/`, { method: 'POST' })).status, 404);

    const client = await registerClient(baseUrl);
    const authorization = await authorize(baseUrl, client.client_id);
    const tokens = await exchangeCode(baseUrl, client.client_id, authorization.code, authorization.verifier);

    const initialize = await mcpRequest(baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'gmail-mcp-process-test', version: '1.0.0' },
        },
    });
    assert.equal(initialize.status, 200);
    assert.match(initialize.headers.get('content-type') || '', /^application\/json/);
    const initializeResult = await initialize.json();
    assert.equal(initializeResult.result.serverInfo.name, 'gmail');
    assert.equal(initializeResult.result.serverInfo.version, '2.0.0');

    const listTools = await mcpRequest(baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
    });
    assert.equal(listTools.status, 200);
    const toolsResult = await listTools.json();
    assert.ok(toolsResult.result.tools.length > 0);
    assert.ok(toolsResult.result.tools.some(tool => tool.name === 'remote_list_accounts'));
    assert.ok(!toolsResult.result.tools.some(tool => tool.name === 'list_accounts'));

    const listAccounts = await mcpRequest(baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'remote_list_accounts', arguments: {} },
    });
    assert.equal(listAccounts.status, 200);
    const listAccountsResult = await listAccounts.json();
    assert.match(listAccountsResult.result.content[0].text, /"accounts"/);

    const hiddenUnprefixedCall = await mcpRequest(baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'list_accounts', arguments: {} },
    });
    assert.equal(hiddenUnprefixedCall.status, 200);
    const hiddenUnprefixedResult = await hiddenUnprefixedCall.json();
    assert.equal(hiddenUnprefixedResult.result.isError, true);
    assert.match(hiddenUnprefixedResult.result.content[0].text, /not found/);


    const sigtermShutdown = await stopServer();
    assert.equal(sigtermShutdown.timedOut, false);
    assert.equal(sigtermShutdown.exitCode, 0);
    assert.match(sigtermShutdown.output, /Received SIGTERM; stopping HTTP accepts/);
    assert.match(sigtermShutdown.output, /HTTP server shutdown complete/);
    ({ baseUrl } = await startServer(port));
    const afterRestart = await mcpRequest(baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
    });
    assert.equal(afterRestart.status, 200, 'access token must survive a process restart');

    const refresh = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: client.client_id,
            resource: `${baseUrl}/mcp`,
        }),
    });
    assert.equal(refresh.status, 200);
    const replay = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: client.client_id,
            resource: `${baseUrl}/mcp`,
        }),
    });
    assert.equal(replay.status, 400, 'rotated refresh tokens must reject replay');

    const sigintShutdown = await stopServer('SIGINT');
    assert.equal(sigintShutdown.timedOut, false);
    assert.equal(sigintShutdown.exitCode, 0);
    assert.match(sigintShutdown.output, /Received SIGINT; stopping HTTP accepts/);

    ({ baseUrl } = await startServer(port, { shutdownTimeoutMs: 250 }));
    const hangingRequest = net.createConnection({ host: '127.0.0.1', port });
    hangingRequest.on('error', () => undefined);
    await new Promise((resolve, reject) => {
        hangingRequest.once('connect', resolve);
        hangingRequest.once('error', reject);
    });
    hangingRequest.write([
        'POST /mcp HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json',
        'Content-Length: 100000',
        '',
        '{',
    ].join('\r\n'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const forcedStart = Date.now();
    const forcedShutdown = await stopServer('SIGTERM');
    const forcedDuration = Date.now() - forcedStart;
    hangingRequest.destroy();
    assert.equal(forcedShutdown.timedOut, false, 'server must enforce its own shutdown deadline');
    assert.equal(forcedShutdown.exitCode, 1);
    assert.ok(forcedDuration < 2_000, `forced shutdown took ${forcedDuration}ms`);
    assert.match(forcedShutdown.output, /shutdown deadline of 250ms expired/);

    console.log('Remote server process test passed.');
} finally {
    await stopServer();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
}
