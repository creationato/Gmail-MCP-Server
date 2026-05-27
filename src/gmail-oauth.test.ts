import { describe, expect, it } from 'vitest';
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
    startRemoteGmailOAuthFlow,
} from './gmail-oauth.js';

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
    it('generates a remote Google auth URL using the public /oauth2callback redirect', () => {
        const oauthPath = writeOAuthKeys();
        const flow = startRemoteGmailOAuthFlow({
            accountEmail: 'User@Gmail.com',
            publicBaseUrl: 'https://hansen-writes-byte-sticks.trycloudflare.com/mcp',
            oauthPath,
        });

        const authUrl = new URL(flow.authUrl);
        expect(authUrl.origin).toBe('https://accounts.google.com');
        expect(authUrl.searchParams.get('redirect_uri')).toBe(
            'https://hansen-writes-byte-sticks.trycloudflare.com/oauth2callback',
        );
        expect(authUrl.searchParams.get('state')).toBe(flow.state);
        expect(flow.accountEmail).toBe('user@gmail.com');
        expect(flow.redirectUri).toBe('https://hansen-writes-byte-sticks.trycloudflare.com/oauth2callback');

        consumePendingGmailOAuthState(flow.state);
    });

    it('can build an auth URL with an exact custom callback URL', () => {
        const oauthPath = writeOAuthKeys();
        const authUrl = buildGmailAuthUrl({
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/custom/callback',
            oauthPath,
        });

        expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe('https://example.com/custom/callback');
    });

    it('rejects missing, invalid, and expired callback state', async () => {
        await expect(completeGmailOAuthCallback({ code: 'code' })).rejects.toMatchObject({
            reason: 'missing_state',
        });

        await expect(completeGmailOAuthCallback({ code: 'code', state: 'unknown-state' })).rejects.toMatchObject({
            reason: 'invalid_state',
        });

        const expiredState = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/oauth2callback',
            ttlMs: -1,
        });

        await expect(completeGmailOAuthCallback({ code: 'code', state: expiredState })).rejects.toMatchObject({
            reason: 'expired_state',
        });
    });

    it('exchanges a callback code and saves credentials when the Gmail profile matches', async () => {
        const oauthPath = writeOAuthKeys();
        const state = createPendingGmailOAuthState({
            accountEmail: 'user@gmail.com',
            scopes: ['gmail.modify', 'gmail.send'],
            redirectUri: 'https://example.com/oauth2callback',
        });
        const tokens: Credentials = { access_token: 'access', refresh_token: 'refresh' };
        let saved: { accountEmail: string; credentials: GmailCredentialsFile } | undefined;

        const result = await completeGmailOAuthCallback({
            code: 'code',
            state,
            oauthPath,
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

    it('does not save credentials when the authenticated account does not match', async () => {
        const oauthPath = writeOAuthKeys();
        const state = createPendingGmailOAuthState({
            accountEmail: 'requested@gmail.com',
            scopes: ['gmail.readonly'],
            redirectUri: 'https://example.com/oauth2callback',
        });
        let saved = false;

        await expect(completeGmailOAuthCallback({
            code: 'code',
            state,
            oauthPath,
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
        expect(() => consumePendingGmailOAuthState(state)).toThrow(GmailOAuthError);
    });
});
