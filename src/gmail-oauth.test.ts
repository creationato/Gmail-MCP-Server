import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Credentials, OAuth2Client } from 'google-auth-library';
import {
    GmailCredentialsFile,
    GmailOAuthError,
    buildGmailAuthUrl,
    completeGmailOAuthCallback,
    consumePendingGmailOAuthState,
    createPendingGmailOAuthState,
    getGmailOAuthListenHost,
    saveCredentialsFile,
    startRemoteGmailOAuthFlow,
    validateLocalOAuthCallbackState,
} from './gmail-oauth.js';
import { OAuthStateStore } from './oauth-store.js';

const openStores: OAuthStateStore[] = [];

function createStateStore(databasePath?: string): OAuthStateStore {
    const target = databasePath ?? path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-state-test-')),
        'state.sqlite3',
    );
    const store = new OAuthStateStore(target);
    openStores.push(store);
    return store;
}

function closeStateStore(store: OAuthStateStore): void {
    store.close();
    openStores.splice(openStores.indexOf(store), 1);
}

afterEach(() => {
    vi.restoreAllMocks();
    while (openStores.length > 0) openStores.pop()?.close();
});

function writeOAuthKeys(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-test-'));
    const oauthPath = path.join(dir, 'gcp-oauth.keys.json');
    fs.writeFileSync(oauthPath, JSON.stringify({
        web: {
            client_id: 'client-id.apps.googleusercontent.com',
            client_secret: 'client-secret',
        },
    }));
    return oauthPath;
}

describe('Gmail OAuth flow helpers', () => {
    it('validates the configurable local OAuth callback listen host', () => {
        expect(getGmailOAuthListenHost({})).toBe('127.0.0.1');
        expect(getGmailOAuthListenHost({ GMAIL_OAUTH_LISTEN_HOST: '0.0.0.0' })).toBe('0.0.0.0');
        expect(getGmailOAuthListenHost({ GMAIL_OAUTH_LISTEN_HOST: 'oauth-listener.internal' }))
            .toBe('oauth-listener.internal');
        expect(() => getGmailOAuthListenHost({ GMAIL_OAUTH_LISTEN_HOST: 'http://0.0.0.0:3000' }))
            .toThrowError(expect.objectContaining({ reason: 'invalid_listen_host' }));
        expect(() => getGmailOAuthListenHost({ GMAIL_OAUTH_LISTEN_HOST: 'bad host' }))
            .toThrowError(expect.objectContaining({ reason: 'invalid_listen_host' }));
    });

    it('atomically replaces credentials and preserves the prior token when replacement fails', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-credentials-atomic-test-'));
        const credentialsPath = path.join(directory, 'user@gmail.com.json');
        const priorCredentials: GmailCredentialsFile = {
            tokens: { access_token: 'prior-access', refresh_token: 'prior-refresh' },
            scopes: ['gmail.readonly'],
        };
        fs.writeFileSync(credentialsPath, `${JSON.stringify(priorCredentials)}\n`, { mode: 0o600 });
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(destination.toString()) === path.resolve(credentialsPath)) {
                throw new Error('simulated rename failure');
            }
            renameSync(source, destination);
        });

        expect(() => saveCredentialsFile(credentialsPath, {
            tokens: { access_token: 'replacement-access', refresh_token: 'replacement-refresh' },
            scopes: ['gmail.modify'],
        })).toThrow('simulated rename failure');

        expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))).toEqual(priorCredentials);
        expect(fs.readdirSync(directory)).toContain('runtime-lock.sqlite3');
        expect(fs.readdirSync(directory).filter(name => (
            name.endsWith('.lock') || name.includes('.stale-') || name.endsWith('.tmp')
        ))).toEqual([]);
    });

    it('does not report failure after an atomic credential replacement has committed', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-credentials-commit-test-'));
        const credentialsPath = path.join(directory, 'user@gmail.com.json');
        const replacement: GmailCredentialsFile = {
            tokens: { access_token: 'replacement-access', refresh_token: 'replacement-refresh' },
            scopes: ['gmail.modify'],
        };
        const fsyncSync = fs.fsyncSync.bind(fs);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
            if (fs.fstatSync(descriptor).isDirectory()) {
                throw new Error('simulated directory fsync failure');
            }
            fsyncSync(descriptor);
        });

        expect(() => saveCredentialsFile(credentialsPath, replacement)).not.toThrow();
        expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))).toEqual(replacement);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('Atomic write committed'),
            expect.any(Error),
        );
    });

    it('generates a remote Google auth URL using the public /oauth2callback redirect', () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const flow = startRemoteGmailOAuthFlow({
            accountEmail: 'User@Gmail.com',
            publicBaseUrl: 'https://mcp.example.test/mcp',
            oauthPath,
            stateStore,
        });

        const authUrl = new URL(flow.authUrl);
        expect(authUrl.origin).toBe('https://accounts.google.com');
        expect(authUrl.searchParams.get('redirect_uri')).toBe(
            'https://mcp.example.test/oauth2callback',
        );
        expect(authUrl.searchParams.get('state')).toBe(flow.state);
        expect(flow.accountEmail).toBe('user@gmail.com');
        expect(flow.redirectUri).toBe('https://mcp.example.test/oauth2callback');

        consumePendingGmailOAuthState(flow.state, stateStore);
    });

    it('can build an auth URL with an exact custom callback URL', () => {
        const oauthPath = writeOAuthKeys();
        const authUrl = buildGmailAuthUrl({
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/custom/callback',
            state: 'expected-state',
            loginHint: 'user@gmail.com',
            oauthPath,
        });

        expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe('https://example.com/custom/callback');
        expect(new URL(authUrl).searchParams.get('state')).toBe('expected-state');
        expect(new URL(authUrl).searchParams.get('login_hint')).toBe('user@gmail.com');
    });

    it('requires exact state binding for local OAuth callbacks', () => {
        expect(() => validateLocalOAuthCallbackState('expected-state', null))
            .toThrowError(expect.objectContaining({ reason: 'missing_state' }));
        expect(() => validateLocalOAuthCallbackState('expected-state', 'different-state'))
            .toThrowError(expect.objectContaining({ reason: 'invalid_state' }));
        expect(() => validateLocalOAuthCallbackState('expected-state', 'expected-state')).not.toThrow();
    });

    it('rejects missing, invalid, and expired callback state', async () => {
        const stateStore = createStateStore();
        await expect(completeGmailOAuthCallback({ code: 'code', stateStore })).rejects.toMatchObject({
            reason: 'missing_state',
        });

        await expect(completeGmailOAuthCallback({ code: 'code', state: 'unknown-state', stateStore })).rejects.toMatchObject({
            reason: 'invalid_state',
        });

        const expiredState = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/oauth2callback',
            ttlMs: -1,
        }, stateStore);

        await expect(completeGmailOAuthCallback({ code: 'code', state: expiredState, stateStore })).rejects.toMatchObject({
            reason: 'expired_state',
        });
    });

    it('exchanges a callback code and saves credentials when the Gmail profile matches', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.modify', 'gmail.send'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        const tokens: Credentials = { access_token: 'access', refresh_token: 'refresh' };
        let saved: { accountEmail: string; credentials: GmailCredentialsFile } | undefined;

        const result = await completeGmailOAuthCallback({
            code: 'code',
            state,
            oauthPath,
            stateStore,
            deps: {
                exchangeCode: async (oauthClient: OAuth2Client, code: string) => {
                    expect(oauthClient).toBeInstanceOf(OAuth2Client);
                    expect(code).toBe('code');
                    return tokens;
                },
                getAuthenticatedEmail: async () => 'user@gmail.com',
                saveCredentials: (accountEmail, credentials) => {
                    saved = { accountEmail, credentials };
                },
            },
        });

        expect(result).toEqual({ accountEmail: 'user@gmail.com', scopes: ['gmail.modify', 'gmail.send'] });
        expect(saved).toEqual({
            accountEmail: 'user@gmail.com',
            credentials: { tokens, scopes: ['gmail.modify', 'gmail.send'] },
        });
    });

    it('allows the same callback to recover after token exchange failure, then rejects replay', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.send'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        let exchangeCalls = 0;
        const deps = {
            exchangeCode: async () => {
                exchangeCalls += 1;
                if (exchangeCalls === 1) throw new Error('temporary exchange failure');
                return { access_token: 'access', refresh_token: 'refresh' };
            },
            getAuthenticatedEmail: async () => 'user@gmail.com',
            saveCredentials: () => undefined,
        };

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toThrow('temporary exchange failure');

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).resolves.toEqual({ accountEmail: 'user@gmail.com', scopes: ['gmail.send'] });
        expect(exchangeCalls).toBe(2);

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toMatchObject({ reason: 'invalid_state' });
    });

    it('persists exchanged tokens so a failed credential save can recover after restart', async () => {
        const oauthPath = writeOAuthKeys();
        const databasePath = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-save-retry-test-')),
            'state.sqlite3',
        );
        const firstStore = createStateStore(databasePath);
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.modify'],
            redirectUri: 'https://example.com/oauth2callback',
        }, firstStore);
        let exchangeCalls = 0;
        let saveCalls = 0;
        const deps = {
            exchangeCode: async () => {
                exchangeCalls += 1;
                return { access_token: 'access', refresh_token: 'refresh' };
            },
            getAuthenticatedEmail: async () => 'user@gmail.com',
            saveCredentials: () => {
                saveCalls += 1;
                if (saveCalls === 1) throw new Error('temporary save failure');
            },
        };

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore: firstStore, deps,
        })).rejects.toThrow('temporary save failure');
        closeStateStore(firstStore);

        const restartedStore = createStateStore(databasePath);
        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore: restartedStore, deps,
        })).resolves.toEqual({ accountEmail: 'user@gmail.com', scopes: ['gmail.modify'] });
        expect(exchangeCalls).toBe(1);
        expect(saveCalls).toBe(2);
    });

    it('makes a callback terminal when Google tokens cannot be journaled', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.modify'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        let exchangeCompleted = false;
        let exchangeCalls = 0;
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (exchangeCompleted && destination.toString().endsWith('.gmail-callbacks.json')) {
                throw new Error('simulated token journal failure');
            }
            renameSync(source, destination);
        });
        const deps = {
            exchangeCode: async () => {
                exchangeCalls += 1;
                exchangeCompleted = true;
                return { access_token: 'access', refresh_token: 'refresh' };
            },
            getAuthenticatedEmail: async () => 'user@gmail.com',
            saveCredentials: () => undefined,
        };

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toMatchObject({ reason: 'callback_outcome_uncertain', statusCode: 409 });
        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toMatchObject({ reason: 'callback_outcome_uncertain', statusCode: 409 });
        expect(exchangeCalls).toBe(1);
    });

    it('does not make a callback replayable after credentials saved but finalization failed', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.send'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        let credentialsSaved = false;
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (credentialsSaved && destination.toString().endsWith('.gmail-callbacks.json')) {
                throw new Error('simulated callback finalization failure');
            }
            renameSync(source, destination);
        });
        const deps = {
            exchangeCode: async () => ({ access_token: 'access', refresh_token: 'refresh' }),
            getAuthenticatedEmail: async () => 'user@gmail.com',
            saveCredentials: () => {
                credentialsSaved = true;
            },
        };

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toMatchObject({ reason: 'callback_outcome_uncertain', statusCode: 409 });
        expect(credentialsSaved).toBe(true);

        await expect(completeGmailOAuthCallback({
            code: 'same-code', state, oauthPath, stateStore, deps,
        })).rejects.toMatchObject({ reason: 'callback_outcome_uncertain', statusCode: 409 });
    });

    it('rejects a concurrent callback while the first attempt owns the state', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        let releaseExchange: ((tokens: Credentials) => void) | undefined;
        const exchangeCode = () => new Promise<Credentials>(resolve => {
            releaseExchange = resolve;
        });
        const firstCallback = completeGmailOAuthCallback({
            code: 'same-code',
            state,
            oauthPath,
            stateStore,
            deps: {
                exchangeCode,
                getAuthenticatedEmail: async () => 'user@gmail.com',
                saveCredentials: () => undefined,
            },
        });

        await expect(completeGmailOAuthCallback({
            code: 'same-code',
            state,
            oauthPath,
            stateStore,
            deps: {
                exchangeCode,
                getAuthenticatedEmail: async () => 'user@gmail.com',
                saveCredentials: () => undefined,
            },
        })).rejects.toMatchObject({ reason: 'callback_outcome_uncertain', statusCode: 409 });

        expect(releaseExchange).toBeTypeOf('function');
        releaseExchange?.({ access_token: 'access', refresh_token: 'refresh' });
        await expect(firstCallback).resolves.toEqual({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
        });
    });

    it('does not save credentials when the authenticated account does not match', async () => {
        const oauthPath = writeOAuthKeys();
        const stateStore = createStateStore();
        const state = createPendingGmailOAuthState({
            accountEmail: 'requested@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/oauth2callback',
        }, stateStore);
        let saved = false;

        await expect(completeGmailOAuthCallback({
            code: 'code',
            state,
            oauthPath,
            stateStore,
            deps: {
                exchangeCode: async () => ({ access_token: 'access' }),
                getAuthenticatedEmail: async () => 'other@gmail.com',
                saveCredentials: () => {
                    saved = true;
                },
            },
        })).rejects.toMatchObject({
            reason: 'account_mismatch',
        });

        expect(saved).toBe(false);
        expect(() => consumePendingGmailOAuthState(state, stateStore)).toThrow(GmailOAuthError);
    });

    it('completes a remote Google callback after the server state store is reopened', async () => {
        const oauthPath = writeOAuthKeys();
        const databasePath = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-restart-test-')),
            'state.sqlite3',
        );
        const firstStore = createStateStore(databasePath);
        const flow = startRemoteGmailOAuthFlow({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            publicBaseUrl: 'https://gmail.example.test/team',
            oauthPath,
            stateStore: firstStore,
        });
        closeStateStore(firstStore);

        const restartedStore = createStateStore(databasePath);
        const result = await completeGmailOAuthCallback({
            code: 'google-code',
            state: flow.state,
            oauthPath,
            stateStore: restartedStore,
            deps: {
                exchangeCode: async () => ({ access_token: 'access', refresh_token: 'refresh' }),
                getAuthenticatedEmail: async () => 'user@gmail.com',
                saveCredentials: () => undefined,
            },
        });
        expect(result).toEqual({ accountEmail: 'user@gmail.com', scopes: ['gmail.readonly'] });
        await expect(completeGmailOAuthCallback({
            code: 'google-code-replay',
            state: flow.state,
            oauthPath,
            stateStore: restartedStore,
            deps: {
                exchangeCode: async () => ({ access_token: 'access' }),
                getAuthenticatedEmail: async () => 'user@gmail.com',
            },
        })).rejects.toMatchObject({ reason: 'invalid_state' });
    });
});
