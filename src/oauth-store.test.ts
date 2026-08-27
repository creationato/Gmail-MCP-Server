import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MAX_OAUTH_CLIENTS,
    MAX_OAUTH_REGISTRATIONS_PER_WINDOW,
    OAuthClientLimitError,
    OAuthStateStore,
} from './oauth-store.js';

const openStores: OAuthStateStore[] = [];

function newDatabasePath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-store-test-')), 'state.sqlite3');
}

function openStore(databasePath: string): OAuthStateStore {
    const store = new OAuthStateStore(databasePath);
    openStores.push(store);
    return store;
}

function closeStore(store: OAuthStateStore): void {
    store.close();
    openStores.splice(openStores.indexOf(store), 1);
}

afterEach(() => {
    while (openStores.length > 0) openStores.pop()?.close();
});

describe('OAuthStateStore', () => {
    it('repairs a partial version-zero schema transactionally', () => {
        const databasePath = newDatabasePath();
        const partial = new DatabaseSync(databasePath);
        partial.exec(`
            CREATE TABLE oauth_clients (
                client_id TEXT PRIMARY KEY,
                redirect_uris TEXT NOT NULL,
                client_name TEXT,
                created_at INTEGER NOT NULL
            );
            INSERT INTO oauth_clients VALUES ('existing', '["https://claude.ai/api/mcp/auth_callback"]', 'Claude', 1);
        `);
        partial.close();

        const store = openStore(databasePath);

        expect(store.getClient('existing')?.clientName).toBe('Claude');
        expect(store.isReady()).toBe(true);
    });

    it('persists clients and uses restricted state-file permissions', () => {
        const databasePath = newDatabasePath();
        const store = openStore(databasePath);
        const client = store.registerClient(['https://claude.ai/api/mcp/auth_callback'], 'Claude');

        expect(fs.statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
        closeStore(store);

        const reopened = openStore(databasePath);
        expect(reopened.getClient(client.clientId)).toEqual(client);
        expect(reopened.isReady()).toBe(true);
    });

    it('hashes secrets, rejects code replay, and rotates refresh tokens across restarts', () => {
        const databasePath = newDatabasePath();
        const audience = 'https://mcp.example.com/mcp';
        const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
        const verifier = 'a'.repeat(64);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const store = openStore(databasePath);
        const client = store.registerClient([redirectUri]);
        const code = store.createAuthorizationCode({
            clientId: client.clientId,
            redirectUri,
            codeChallenge: challenge,
            scope: 'gmail offline_access',
            audience,
            expiresAt: Date.now() + 60_000,
        });

        const tokens = store.exchangeAuthorizationCode({
            code,
            clientId: client.clientId,
            redirectUri,
            codeVerifier: verifier,
            audience,
        });
        expect(tokens).toBeDefined();
        expect(store.exchangeAuthorizationCode({
            code,
            clientId: client.clientId,
            redirectUri,
            codeVerifier: verifier,
            audience,
        })).toBeUndefined();
        expect(store.verifyAccessToken(tokens!.access_token, audience)).toBe(true);
        expect(store.verifyAccessToken(tokens!.access_token, 'https://other.example/mcp')).toBe(false);

        const databaseBytes = fs.readFileSync(databasePath);
        expect(databaseBytes.includes(Buffer.from(code))).toBe(false);
        expect(databaseBytes.includes(Buffer.from(tokens!.access_token))).toBe(false);
        expect(databaseBytes.includes(Buffer.from(tokens!.refresh_token))).toBe(false);
        closeStore(store);

        const reopened = openStore(databasePath);
        expect(reopened.verifyAccessToken(tokens!.access_token, audience)).toBe(true);
        const rotated = reopened.rotateRefreshToken({
            refreshToken: tokens!.refresh_token,
            clientId: client.clientId,
            audience,
        });
        expect(rotated).toBeDefined();
        expect(rotated!.refresh_token).not.toBe(tokens!.refresh_token);
        expect(reopened.verifyAccessToken(rotated!.access_token, audience)).toBe(true);
        expect(reopened.rotateRefreshToken({
            refreshToken: tokens!.refresh_token,
            clientId: client.clientId,
            audience,
        })).toBeUndefined();
        expect(reopened.verifyAccessToken(rotated!.access_token, audience)).toBe(false);
    });

    it('deduplicates registrations and protects active clients at the durable bound', () => {
        const store = openStore(newDatabasePath());
        const redirect = 'https://claude.ai/api/mcp/auth_callback';
        const first = store.registerClient([redirect], 'Claude');
        expect(store.registerClient([redirect], 'Claude')).toEqual(first);

        const start = Date.now();
        store.createAuthorizationCode({
            clientId: first.clientId,
            redirectUri: redirect,
            codeChallenge: 'challenge',
            scope: 'gmail',
            audience: 'https://mcp.example.test/mcp',
            expiresAt: start + 60_000,
        });
        for (let index = 1; index < MAX_OAUTH_CLIENTS; index += 1) {
            const client = store.registerClient(
                [redirect],
                `client-${index}`,
                start,
                `source-${index}`,
            );
            store.createAuthorizationCode({
                clientId: client.clientId,
                redirectUri: redirect,
                codeChallenge: 'challenge',
                scope: 'gmail',
                audience: 'https://mcp.example.test/mcp',
                expiresAt: start + 60_000,
            });
        }
        expect(() => store.registerClient([redirect], 'one-too-many', start, 'new-source'))
            .toThrow(OAuthClientLimitError);
    });

    it('evicts abandoned registrations instead of globally denying new connectors', () => {
        const store = openStore(newDatabasePath());
        const redirect = 'https://claude.ai/api/mcp/auth_callback';
        const start = Date.now();
        const first = store.registerClient([redirect], 'abandoned-0', start, 'source-0');
        for (let index = 1; index < MAX_OAUTH_CLIENTS; index += 1) {
            store.registerClient(
                [redirect],
                `abandoned-${index}`,
                start + index,
                `source-${index}`,
            );
        }

        const replacement = store.registerClient(
            [redirect],
            'legitimate-connector',
            start + MAX_OAUTH_CLIENTS,
            'legitimate-source',
        );

        expect(store.getClient(replacement.clientId)).toEqual(replacement);
        expect(store.getClient(first.clientId)).toBeUndefined();
    });

    it('rate limits anonymous registrations without penalizing duplicates', () => {
        const store = openStore(newDatabasePath());
        const redirect = 'https://claude.ai/api/mcp/auth_callback';
        const now = Date.now();
        const first = store.registerClient([redirect], 'same-client', now, 'source-a');
        expect(store.registerClient([redirect], 'same-client', now, 'source-a')).toEqual(first);
        for (let index = 1; index < MAX_OAUTH_REGISTRATIONS_PER_WINDOW; index += 1) {
            store.registerClient([redirect], `rapid-${index}`, now, 'source-a');
        }
        expect(() => store.registerClient([redirect], 'rate-limited', now, 'source-a'))
            .toThrow(/rate limit/);
        expect(store.registerClient([redirect], 'different-source', now, 'source-b').clientId)
            .toMatch(/^client_/);
    });

    it('reconstructs schema-v1 access and refresh token families', () => {
        const databasePath = newDatabasePath();
        const legacy = new DatabaseSync(databasePath);
        const accessToken = 'legacy-access-token';
        const refreshToken = 'legacy-refresh-token';
        const clientId = 'legacy-client';
        const audience = 'https://mcp.example.test/mcp';
        const createdAt = Date.now();
        const expiresAt = createdAt + 60_000;
        legacy.exec(`
            CREATE TABLE oauth_clients (
                client_id TEXT PRIMARY KEY,
                redirect_uris TEXT NOT NULL,
                client_name TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE access_tokens (
                secret_hash TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                audience TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE refresh_tokens (
                secret_hash TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                scope TEXT NOT NULL,
                audience TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            PRAGMA user_version = 1;
        `);
        legacy.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)').run(
            clientId,
            '["https://claude.ai/api/mcp/auth_callback"]',
            'Legacy',
            createdAt,
        );
        legacy.prepare('INSERT INTO access_tokens VALUES (?, ?, ?, ?, ?, ?)').run(
            createHash('sha256').update(accessToken).digest('hex'),
            clientId,
            'gmail offline_access',
            audience,
            expiresAt,
            createdAt,
        );
        legacy.prepare('INSERT INTO refresh_tokens VALUES (?, ?, ?, ?, ?, ?)').run(
            createHash('sha256').update(refreshToken).digest('hex'),
            clientId,
            'gmail offline_access',
            audience,
            expiresAt,
            createdAt,
        );
        legacy.close();

        const store = openStore(databasePath);
        expect(store.verifyAccessToken(accessToken, audience)).toBe(true);
        const rotated = store.rotateRefreshToken({ refreshToken, clientId, audience, now: createdAt })!;
        expect(store.verifyAccessToken(rotated.access_token, audience, createdAt)).toBe(true);
        expect(store.rotateRefreshToken({ refreshToken, clientId, audience, now: createdAt }))
            .toBeUndefined();
        expect(store.verifyAccessToken(accessToken, audience, createdAt)).toBe(false);
        expect(store.verifyAccessToken(rotated.access_token, audience, createdAt)).toBe(false);
    });

    it('revokes the complete token family using either token type', () => {
        const store = openStore(newDatabasePath());
        const audience = 'https://mcp.example.com/mcp';
        const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
        const verifier = 'r'.repeat(64);
        const client = store.registerClient([redirectUri]);
        const code = store.createAuthorizationCode({
            clientId: client.clientId,
            redirectUri,
            codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
            scope: 'gmail offline_access',
            audience,
            expiresAt: Date.now() + 60_000,
        });
        const tokens = store.exchangeAuthorizationCode({
            code,
            clientId: client.clientId,
            redirectUri,
            codeVerifier: verifier,
            audience,
        })!;

        store.revokeToken(tokens.refresh_token, client.clientId);

        expect(store.verifyAccessToken(tokens.access_token, audience)).toBe(false);
        expect(store.rotateRefreshToken({
            refreshToken: tokens.refresh_token,
            clientId: client.clientId,
            audience,
        })).toBeUndefined();
    });

    it('persists Google callback state and consumes it exactly once', () => {
        const databasePath = newDatabasePath();
        const store = openStore(databasePath);
        const pending = store.createGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://mcp.example.com/oauth2callback',
        }, 60_000);
        closeStore(store);

        const reopened = openStore(databasePath);
        expect(reopened.consumeGmailOAuthState(pending.state)).toEqual({
            status: 'valid',
            record: pending.record,
        });
        expect(reopened.consumeGmailOAuthState(pending.state)).toEqual({ status: 'missing' });

        const expired = reopened.createGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://mcp.example.com/oauth2callback',
        }, -1);
        expect(reopened.consumeGmailOAuthState(expired.state)).toEqual({ status: 'expired' });
    });
});
