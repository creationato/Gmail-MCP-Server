import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
    request as httpRequest,
    type ClientRequest,
    type IncomingHttpHeaders,
    type Server,
} from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_OAUTH_REGISTRATIONS_PER_WINDOW, OAuthStateStore } from './oauth-store.js';
import {
    createRemoteHttpApp,
    loadRemoteServerConfig,
    MCP_IN_FLIGHT_BODY_BUDGET_BYTES,
    MCP_JSON_BODY_LIMIT_BYTES,
    MCP_MAX_IN_FLIGHT_REQUESTS,
    REMOTE_MCP_SCOPE,
    RemoteConfigurationError,
    RemoteServerConfig,
} from './remote-http.js';

const CALLBACK_URL = 'https://claude.ai/api/mcp/auth_callback';
const openServers: Server[] = [];
const openStores: OAuthStateStore[] = [];

function testEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        GMAIL_MCP_API_KEY: 'connector-api-key-0123456789abcdef',
        GMAIL_MCP_PUBLIC_ORIGIN: 'https://gmail.example.test',
        GMAIL_MCP_OAUTH_CALLBACKS: CALLBACK_URL,
        ...overrides,
    };
}

function openStore(databasePath?: string): OAuthStateStore {
    const target = databasePath ?? path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-http-test-')),
        'state.sqlite3',
    );
    const store = new OAuthStateStore(target);
    openStores.push(store);
    return store;
}

function closeStore(store: OAuthStateStore): void {
    store.close();
    openStores.splice(openStores.indexOf(store), 1);
}

async function listen(
    config: RemoteServerConfig,
    store: OAuthStateStore,
    onMcp?: (req: express.Request, res: express.Response) => Promise<void>,
): Promise<{ server: Server; url: string }> {
    const app = createRemoteHttpApp(config, store, {
        completeGmailOAuthCallback: async () => ({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
        }),
        handleMcpRequest: onMcp ?? (async (_req, res) => {
            res.json({ handled: true });
        }),
    });
    const server = app.listen(0, '127.0.0.1');
    openServers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server.');
    return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    openServers.splice(openServers.indexOf(server), 1);
}

function issueAccessToken(config: RemoteServerConfig, store: OAuthStateStore): string {
    const verifier = 'b'.repeat(64);
    const client = store.registerClient([CALLBACK_URL], 'Body limit test');
    const code = store.createAuthorizationCode({
        clientId: client.clientId,
        redirectUri: CALLBACK_URL,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        scope: REMOTE_MCP_SCOPE,
        audience: config.resourceUrl,
        expiresAt: Date.now() + 60_000,
    });
    const tokens = store.exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        redirectUri: CALLBACK_URL,
        codeVerifier: verifier,
        audience: config.resourceUrl,
    });
    if (!tokens) throw new Error('Failed to issue an access token for the HTTP test.');
    return tokens.access_token;
}

function jsonPayloadWithByteLength(byteLength: number): string {
    const prefix = '{"payload":"';
    const suffix = '"}';
    const payloadLength = byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    if (payloadLength < 0) throw new Error('Requested JSON payload is too small.');
    return `${prefix}${'a'.repeat(payloadLength)}${suffix}`;
}

type TestHttpResponse = {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
};

function startStreamingRequest(
    target: string,
    accessToken: string | undefined,
    headers: Record<string, string> = {},
): { request: ClientRequest; response: Promise<TestHttpResponse> } {
    let request!: ClientRequest;
    const response = new Promise<TestHttpResponse>((resolve, reject) => {
        request = httpRequest(target, {
            method: 'POST',
            headers: {
                ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
                'content-type': 'application/json',
                ...headers,
            },
        }, incoming => {
            incoming.setEncoding('utf8');
            let body = '';
            incoming.on('data', chunk => { body += chunk; });
            incoming.once('end', () => resolve({
                status: incoming.statusCode ?? 0,
                headers: incoming.headers,
                body,
            }));
        });
        request.once('error', reject);
    });
    return { request, response };
}

async function chunkedJsonRequest(
    target: string,
    accessToken: string,
    body: string,
    headers: Record<string, string> = {},
): Promise<TestHttpResponse> {
    const pending = startStreamingRequest(target, accessToken, headers);
    pending.request.write(body);
    pending.request.end();
    return pending.response;
}

async function startIncompleteJsonRequest(target: string, accessToken: string): Promise<net.Socket> {
    const url = new URL(target);
    const socket = net.createConnection({
        host: url.hostname,
        port: Number(url.port),
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    socket.write([
        `POST ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        `Authorization: Bearer ${accessToken}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
    ].join('\r\n'));
    return socket;
}

async function expectSafeJsonFailure(
    response: Response,
    status: number,
    error: string,
): Promise<Record<string, unknown>> {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await response.text();
    expect(text).not.toMatch(/<!doctype|<html|<pre|SyntaxError|remote-http\.(?:ts|js)|\/home\//i);
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload.error).toBe(error);
    expect(payload).not.toHaveProperty('stack');
    return payload;
}

afterEach(async () => {
    while (openServers.length > 0) await closeServer(openServers[0]);
    while (openStores.length > 0) openStores.pop()?.close();
});

describe('remote server configuration', () => {
    it('builds exact root routes from the new public-origin settings', () => {
        const config = loadRemoteServerConfig(testEnvironment());
        expect(config).toMatchObject({
            publicOrigin: 'https://gmail.example.test',
            basePath: '',
            issuerUrl: 'https://gmail.example.test',
            mcpPath: '/mcp',
            resourceUrl: 'https://gmail.example.test/mcp',
            protectedResourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
            authorizationServerMetadataPath: '/.well-known/oauth-authorization-server',
            revokePath: '/revoke',
        });
    });

    it('preserves GMAIL_MCP_PUBLIC_URL and infers its base-path prefix', () => {
        const config = loadRemoteServerConfig({
            GMAIL_MCP_API_KEY: 'connector-api-key-0123456789abcdef',
            GMAIL_MCP_PUBLIC_URL: 'https://gmail.example.test/team/mcp',
            GMAIL_MCP_OAUTH_CALLBACKS: CALLBACK_URL,
        });
        expect(config.basePath).toBe('/team');
        expect(config.mcpPath).toBe('/team/mcp');
        expect(config.issuerUrl).toBe('https://gmail.example.test/team');
        expect(config.authorizationServerMetadataPath).toBe('/.well-known/oauth-authorization-server/team');
    });

    it('fails closed when any remote security setting is absent', () => {
        expect(() => loadRemoteServerConfig({
            GMAIL_MCP_PUBLIC_ORIGIN: 'https://gmail.example.test',
            GMAIL_MCP_OAUTH_CALLBACKS: CALLBACK_URL,
        })).toThrow(RemoteConfigurationError);
        expect(() => loadRemoteServerConfig({
            GMAIL_MCP_API_KEY: 'connector-api-key-0123456789abcdef',
            GMAIL_MCP_OAUTH_CALLBACKS: CALLBACK_URL,
        })).toThrow(RemoteConfigurationError);
        expect(() => loadRemoteServerConfig({
            GMAIL_MCP_API_KEY: 'connector-api-key-0123456789abcdef',
            GMAIL_MCP_PUBLIC_ORIGIN: 'https://gmail.example.test',
        })).toThrow(RemoteConfigurationError);
        expect(() => loadRemoteServerConfig(testEnvironment({
            GMAIL_MCP_API_KEY: 'too-short',
        }))).toThrow(/at least 32 bytes/);
    });
});

describe('remote HTTP OAuth process', () => {
    it('accepts MCP JSON below 32 MiB and deterministically rejects an oversized body', async () => {
        const config = loadRemoteServerConfig(testEnvironment());
        const store = openStore();
        let handledPayloadLength: number | undefined;
        const { url } = await listen(config, store, async (req, res) => {
            handledPayloadLength = typeof req.body?.payload === 'string'
                ? req.body.payload.length
                : undefined;
            res.json({ handled: true });
        });
        const accessToken = issueAccessToken(config, store);
        const headers = {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
        };

        const unauthenticatedMalformed = await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
        });
        expect(unauthenticatedMalformed.status).toBe(401);

        const acceptedBody = jsonPayloadWithByteLength(MCP_JSON_BODY_LIMIT_BYTES - 1);
        const accepted = await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers,
            body: acceptedBody,
        });
        expect(accepted.status).toBe(200);
        expect(handledPayloadLength).toBe(acceptedBody.length - '{"payload":""}'.length);

        const rejected = await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers,
            body: jsonPayloadWithByteLength(MCP_JSON_BODY_LIMIT_BYTES + 1),
        });
        expect(rejected.status).toBe(413);
        expect(rejected.headers.get('cache-control')).toBe('no-store');
        expect(await rejected.json()).toEqual({
            error: 'request_too_large',
            error_description: `MCP JSON request bodies are limited to ${MCP_JSON_BODY_LIMIT_BYTES} bytes.`,
            max_bytes: MCP_JSON_BODY_LIMIT_BYTES,
        });
        expect(handledPayloadLength).toBe(acceptedBody.length - '{"payload":""}'.length);
    }, 30_000);

    it('bounds authenticated in-flight bodies and releases capacity on every terminal path', async () => {
        expect(MCP_IN_FLIGHT_BODY_BUDGET_BYTES).toBe(MCP_JSON_BODY_LIMIT_BYTES);
        expect(MCP_MAX_IN_FLIGHT_REQUESTS).toBeGreaterThan(0);
        const config = loadRemoteServerConfig(testEnvironment());
        const store = openStore();
        let releaseHeld!: () => void;
        let markHeldEntered!: () => void;
        let releaseDisconnected!: () => void;
        let markDisconnectedEntered!: () => void;
        let releaseCounted!: () => void;
        let markCountedEntered!: () => void;
        let countedRequests = 0;
        const held = new Promise<void>(resolve => { releaseHeld = resolve; });
        const heldEntered = new Promise<void>(resolve => { markHeldEntered = resolve; });
        const disconnected = new Promise<void>(resolve => { releaseDisconnected = resolve; });
        const disconnectedEntered = new Promise<void>(resolve => { markDisconnectedEntered = resolve; });
        const counted = new Promise<void>(resolve => { releaseCounted = resolve; });
        const countedEntered = new Promise<void>(resolve => { markCountedEntered = resolve; });
        const { url } = await listen(config, store, async (req, res) => {
            if (req.body?.mode === 'hold') {
                markHeldEntered();
                await held;
            }
            if (req.body?.mode === 'disconnect') {
                markDisconnectedEntered();
                await disconnected;
            }
            if (req.body?.mode === 'fail') throw new Error('expected downstream failure');
            if (req.body?.mode === 'count') {
                countedRequests += 1;
                if (countedRequests === MCP_MAX_IN_FLIGHT_REQUESTS) markCountedEntered();
                await counted;
            }
            if (!res.destroyed) res.json({ handled: true });
        });
        const accessToken = issueAccessToken(config, store);
        const target = `${url}${config.mcpPath}`;

        const first = startStreamingRequest(target, accessToken);
        first.request.write(JSON.stringify({ mode: 'hold' }));
        first.request.end();
        await heldEntered;

        const busy = await chunkedJsonRequest(target, accessToken, '{}');
        expect(busy.status).toBe(503);
        expect(busy.headers['retry-after']).toBe('1');
        expect(busy.headers['cache-control']).toBe('no-store');
        expect(JSON.parse(busy.body)).toMatchObject({ error: 'server_busy' });
        const unauthenticatedDuringExhaustion = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        expect(unauthenticatedDuringExhaustion.status).toBe(401);

        releaseHeld();
        expect((await first.response).status).toBe(200);
        expect((await chunkedJsonRequest(target, accessToken, '{}')).status).toBe(200);

        const countedResponses = Array.from({ length: MCP_MAX_IN_FLIGHT_REQUESTS }, () => fetch(target, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mode: 'count' }),
        }));
        await countedEntered;
        const countBusy = await fetch(target, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(countBusy.status).toBe(503);
        expect(countBusy.headers.get('retry-after')).toBe('1');
        releaseCounted();
        expect((await Promise.all(countedResponses)).map(response => response.status))
            .toEqual(Array(MCP_MAX_IN_FLIGHT_REQUESTS).fill(200));

        const failed = await chunkedJsonRequest(target, accessToken, JSON.stringify({ mode: 'fail' }));
        expect(failed.status).toBe(500);
        expect((await chunkedJsonRequest(target, accessToken, '{}')).status).toBe(200);

        const closed = startStreamingRequest(target, accessToken);
        closed.request.write(JSON.stringify({ mode: 'disconnect' }));
        closed.request.end();
        await disconnectedEntered;
        closed.request.destroy();
        await expect(closed.response).rejects.toThrow();

        let recovered: TestHttpResponse | undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            recovered = await chunkedJsonRequest(target, accessToken, '{}');
            if (recovered.status === 200) break;
            expect(recovered.status).toBe(503);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(recovered?.status).toBe(200);
        releaseDisconnected();

        const incomplete = await startIncompleteJsonRequest(target, accessToken);
        let incompleteHeldBudget = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const probe = await chunkedJsonRequest(target, accessToken, '{}');
            if (probe.status === 503) {
                incompleteHeldBudget = true;
                break;
            }
            expect(probe.status).toBe(200);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(incompleteHeldBudget).toBe(true);
        const incompleteClosed = new Promise<void>(resolve => incomplete.once('close', () => resolve()));
        incomplete.destroy();
        await incompleteClosed;

        recovered = undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            recovered = await chunkedJsonRequest(target, accessToken, '{}');
            if (recovered.status === 200) break;
            expect(recovered.status).toBe(503);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(recovered?.status).toBe(200);
    });

    it('returns deterministic JSON for media and body-parser failures without leaking stacks', async () => {
        const config = loadRemoteServerConfig(testEnvironment());
        const store = openStore();
        const { url } = await listen(config, store);
        const accessToken = issueAccessToken(config, store);
        const target = `${url}${config.mcpPath}`;
        const authorization = { authorization: `Bearer ${accessToken}` };

        const malformed = await fetch(target, {
            method: 'POST',
            headers: { ...authorization, 'content-type': 'application/json' },
            body: '{',
        });
        expect(await expectSafeJsonFailure(malformed, 400, 'invalid_json')).toEqual({
            error: 'invalid_json',
            error_description: 'MCP request body must contain valid JSON.',
        });
        expect((await chunkedJsonRequest(target, accessToken, '{}')).status).toBe(200);

        const unsupportedCharset = await fetch(target, {
            method: 'POST',
            headers: { ...authorization, 'content-type': 'application/json; charset=iso-8859-1' },
            body: '{}',
        });
        await expectSafeJsonFailure(unsupportedCharset, 415, 'unsupported_charset');
        expect((await chunkedJsonRequest(target, accessToken, '{}')).status).toBe(200);

        const unsupportedEncoding = await fetch(target, {
            method: 'POST',
            headers: {
                ...authorization,
                'content-type': 'application/json',
                'content-encoding': 'compress',
            },
            body: '{}',
        });
        await expectSafeJsonFailure(unsupportedEncoding, 415, 'unsupported_content_encoding');
        expect((await chunkedJsonRequest(target, accessToken, '{}')).status).toBe(200);

        for (const contentType of ['text/plain', 'application/problem+json']) {
            const unsupportedMedia = await fetch(target, {
                method: 'POST',
                headers: { ...authorization, 'content-type': contentType },
                body: '{}',
            });
            await expectSafeJsonFailure(unsupportedMedia, 415, 'unsupported_media_type');
        }

        const streamingMedia = startStreamingRequest(target, accessToken, {
            'content-type': 'text/plain',
        });
        streamingMedia.request.write('body remains open');
        const streamingMediaResponse = await streamingMedia.response;
        expect(streamingMediaResponse.status).toBe(415);
        expect(streamingMediaResponse.headers['cache-control']).toBe('no-store');
        expect(JSON.parse(streamingMediaResponse.body)).toMatchObject({ error: 'unsupported_media_type' });
        streamingMedia.request.destroy();
    });

    it('rate limits DCR per trusted client address without denying other clients', async () => {
        const config = loadRemoteServerConfig(testEnvironment());
        const store = openStore();
        const { url } = await listen(config, store);
        const register = (name: string, source: string) => fetch(`${url}${config.registerPath}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-forwarded-for': source,
            },
            body: JSON.stringify({ redirect_uris: [CALLBACK_URL], client_name: name }),
        });

        for (let index = 0; index < MAX_OAUTH_REGISTRATIONS_PER_WINDOW; index += 1) {
            expect((await register(`source-a-${index}`, '198.51.100.10')).status).toBe(201);
        }
        expect((await register('source-a-blocked', '198.51.100.10')).status).toBe(429);
        expect((await register('source-b-allowed', '203.0.113.20')).status).toBe(201);
    });

    it('enforces callback, PKCE, audience, replay, rotation, exact paths, and restart persistence', async () => {
        const config = loadRemoteServerConfig(testEnvironment({ GMAIL_MCP_BASE_PATH: '/gmail' }));
        const databasePath = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-http-restart-test-')),
            'state.sqlite3',
        );
        let store = openStore(databasePath);
        let { server, url } = await listen(config, store);

        expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
        expect(await (await fetch(`${url}/readyz`)).json()).toEqual({ status: 'ready' });

        const metadata = await (await fetch(`${url}${config.protectedResourceMetadataPath}`)).json();
        expect(metadata).toMatchObject({
            resource: config.resourceUrl,
            authorization_servers: [config.issuerUrl],
        });
        const authMetadata = await (await fetch(`${url}${config.authorizationServerMetadataPath}`)).json();
        expect(authMetadata).toMatchObject({
            issuer: config.issuerUrl,
            authorization_endpoint: `${config.issuerUrl}/authorize`,
            revocation_endpoint: `${config.issuerUrl}/revoke`,
        });
        for (const legacyPath of [`${config.basePath}/sse`, `${config.basePath}/messages`]) {
            const legacyResponse = await fetch(`${url}${legacyPath}`);
            expect(legacyResponse.status).toBe(410);
            expect(await legacyResponse.json()).toMatchObject({
                error: 'legacy_transport_removed',
            });
        }

        const rejectedRegistration = await fetch(`${url}${config.registerPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }),
        });
        expect(rejectedRegistration.status).toBe(400);

        const registrationResponse = await fetch(`${url}${config.registerPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: [CALLBACK_URL], client_name: 'Claude' }),
        });
        expect(registrationResponse.status).toBe(201);
        const registration = await registrationResponse.json() as { client_id: string };
        const duplicateRegistration = await fetch(`${url}${config.registerPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: [CALLBACK_URL], client_name: 'Claude' }),
        });
        expect((await duplicateRegistration.json() as { client_id: string }).client_id)
            .toBe(registration.client_id);

        const verifier = 'v'.repeat(64);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const authorizeParams = new URLSearchParams({
            response_type: 'code',
            client_id: registration.client_id,
            redirect_uri: CALLBACK_URL,
            scope: 'gmail offline_access',
            state: 'client-state',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: config.resourceUrl,
        });
        const authorizePage = await fetch(`${url}${config.authorizePath}?${authorizeParams}`);
        expect(authorizePage.status).toBe(200);
        expect(await authorizePage.text()).toContain(`action="${config.authorizePath}"`);

        const wrongKey = await fetch(`${url}${config.authorizePath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), api_key: 'wrong' }),
            redirect: 'manual',
        });
        expect(wrongKey.status).toBe(401);

        const authorization = await fetch(`${url}${config.authorizePath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...Object.fromEntries(authorizeParams), api_key: config.apiKey }),
            redirect: 'manual',
        });
        expect(authorization.status).toBe(302);
        const callback = new URL(authorization.headers.get('location')!);
        expect(callback.origin + callback.pathname).toBe(CALLBACK_URL);
        expect(callback.searchParams.get('state')).toBe('client-state');
        const code = callback.searchParams.get('code')!;

        const exchangeBody = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: registration.client_id,
            redirect_uri: CALLBACK_URL,
            code_verifier: verifier,
            resource: config.resourceUrl,
        });
        const tokenResponse = await fetch(`${url}${config.tokenPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: exchangeBody,
        });
        expect(tokenResponse.status).toBe(200);
        const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };

        const replay = await fetch(`${url}${config.tokenPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: exchangeBody,
        });
        expect(replay.status).toBe(400);

        const noToken = await fetch(`${url}${config.mcpPath}`, { method: 'POST' });
        expect(noToken.status).toBe(401);
        expect(noToken.headers.get('www-authenticate')).toContain(config.protectedResourceMetadataPath);
        expect((await fetch(`${url}${config.mcpPath}?api_key=${config.apiKey}`, { method: 'POST' })).status).toBe(401);
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${config.apiKey}` },
        })).status).toBe(401);
        expect((await fetch(`${url}${config.mcpPath}/`, {
            method: 'POST',
            headers: { authorization: `Bearer ${tokens.access_token}` },
        })).status).toBe(404);
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${tokens.access_token}`,
                'content-type': 'application/json',
            },
            body: '{}',
        })).status).toBe(200);

        await closeServer(server);
        closeStore(store);
        store = openStore(databasePath);
        ({ server, url } = await listen(config, store));
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${tokens.access_token}`,
                'content-type': 'application/json',
            },
            body: '{}',
        })).status).toBe(200);

        const refreshBody = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: registration.client_id,
            resource: config.resourceUrl,
        });
        const refreshResponse = await fetch(`${url}${config.tokenPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: refreshBody,
        });
        expect(refreshResponse.status).toBe(200);
        const rotated = await refreshResponse.json() as { access_token: string; refresh_token: string };
        expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${rotated.access_token}`,
                'content-type': 'application/json',
            },
            body: '{}',
        })).status).toBe(200);
        expect((await fetch(`${url}${config.tokenPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: refreshBody,
        })).status).toBe(400);
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${rotated.access_token}` },
        })).status).toBe(401);

        const revocation = await fetch(`${url}${config.revokePath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                token: rotated.refresh_token,
                client_id: registration.client_id,
            }),
        });
        expect(revocation.status).toBe(200);
        expect((await fetch(`${url}${config.mcpPath}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${rotated.access_token}` },
        })).status).toBe(401);
    });
});
