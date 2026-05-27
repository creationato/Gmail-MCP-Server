import { randomBytes } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { google } from 'googleapis';
import open from 'open';
import { DEFAULT_SCOPES, scopeNamesToUrls, validateScopes } from './scopes.js';
import { ensureDirectories, getAccountCredentialsPath } from './db.js';

export const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
export const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
export const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');
export const LOCAL_GMAIL_CALLBACK_URL = 'http://localhost:3000/oauth2callback';

const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export type GmailOAuthErrorReason =
    | 'missing_oauth_keys'
    | 'invalid_oauth_keys'
    | 'invalid_account'
    | 'invalid_scopes'
    | 'missing_code'
    | 'missing_state'
    | 'invalid_state'
    | 'expired_state'
    | 'token_exchange_failed'
    | 'profile_fetch_failed'
    | 'account_mismatch';

export class GmailOAuthError extends Error {
    constructor(
        public readonly reason: GmailOAuthErrorReason,
        message: string,
        public readonly statusCode = 400,
    ) {
        super(message);
        this.name = 'GmailOAuthError';
    }
}

export interface GoogleOAuthClientKeys {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
}

interface GoogleOAuthKeysFile {
    installed?: Partial<GoogleOAuthClientKeys>;
    web?: Partial<GoogleOAuthClientKeys>;
}

export interface GmailCredentialsFile {
    tokens: Credentials;
    scopes: string[];
}

export interface PendingGmailOAuthState {
    accountEmail: string;
    scopes: string[];
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
}

const pendingGmailOAuthStates = new Map<string, PendingGmailOAuthState>();

export function normalizeAccountEmail(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
        throw new GmailOAuthError('invalid_account', 'Invalid Gmail account email address.');
    }
    return normalized;
}

export function validateRequestedScopes(scopes: string[]): string[] {
    const normalized = scopes.map(scope => scope.trim()).filter(Boolean);
    const validation = validateScopes(normalized);
    if (!validation.valid) {
        throw new GmailOAuthError(
            'invalid_scopes',
            `Invalid scope(s): ${validation.invalid.join(', ')}`,
        );
    }
    return normalized;
}

export function loadOAuthKeys(oauthPath = OAUTH_PATH): GoogleOAuthClientKeys {
    if (!fs.existsSync(oauthPath)) {
        throw new GmailOAuthError(
            'missing_oauth_keys',
            `OAuth keys file not found at ${oauthPath}. Please place gcp-oauth.keys.json in the ~/.gmail-mcp directory.`,
            500,
        );
    }

    let keysContent: GoogleOAuthKeysFile;
    try {
        keysContent = JSON.parse(fs.readFileSync(oauthPath, 'utf8')) as GoogleOAuthKeysFile;
    } catch (error) {
        throw new GmailOAuthError(
            'invalid_oauth_keys',
            `Invalid OAuth keys file at ${oauthPath}: ${(error as Error).message}`,
            500,
        );
    }
    const keys = keysContent.installed || keysContent.web;
    if (!keys?.client_id || !keys.client_secret) {
        throw new GmailOAuthError(
            'invalid_oauth_keys',
            'Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.',
            500,
        );
    }

    return {
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        redirect_uris: keys.redirect_uris,
    };
}

export function createGmailOAuthClient(
    redirectUri: string,
    keys: GoogleOAuthClientKeys = loadOAuthKeys(),
): OAuth2Client {
    return new OAuth2Client(keys.client_id, keys.client_secret, redirectUri);
}

export function saveCredentialsFile(filePath: string, credentials: GmailCredentialsFile): void {
    ensureDirectories();
    fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
}

export function saveAccountCredentials(accountEmail: string, credentials: GmailCredentialsFile): string {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    const targetCredPath = getAccountCredentialsPath(normalizedEmail);
    saveCredentialsFile(targetCredPath, credentials);
    return targetCredPath;
}

export function cleanupPendingGmailOAuthStates(): void {
    const now = Date.now();
    for (const [state, record] of pendingGmailOAuthStates) {
        if (record.expiresAt <= now) {
            pendingGmailOAuthStates.delete(state);
        }
    }
}

export function createPendingGmailOAuthState(params: {
    accountEmail: string;
    scopes: string[];
    redirectUri: string;
    ttlMs?: number;
}): string {
    cleanupPendingGmailOAuthStates();

    const now = Date.now();
    const state = randomBytes(32).toString('base64url');
    pendingGmailOAuthStates.set(state, {
        accountEmail: normalizeAccountEmail(params.accountEmail),
        scopes: validateRequestedScopes(params.scopes),
        redirectUri: params.redirectUri,
        createdAt: now,
        expiresAt: now + (params.ttlMs ?? GMAIL_OAUTH_STATE_TTL_MS),
    });
    return state;
}

export function consumePendingGmailOAuthState(state?: string): PendingGmailOAuthState {
    if (!state) {
        throw new GmailOAuthError('missing_state', 'Missing OAuth state.');
    }

    const record = pendingGmailOAuthStates.get(state);
    if (!record) {
        throw new GmailOAuthError('invalid_state', 'OAuth state is invalid or has already been used.');
    }

    pendingGmailOAuthStates.delete(state);
    if (record.expiresAt <= Date.now()) {
        throw new GmailOAuthError('expired_state', 'OAuth state has expired. Please start authentication again.');
    }

    return record;
}

export function buildGmailAuthUrl(params: {
    scopes: string[];
    redirectUri: string;
    state?: string;
    oauthPath?: string;
}): string {
    const keys = loadOAuthKeys(params.oauthPath);
    const oauthClient = createGmailOAuthClient(params.redirectUri, keys);
    return oauthClient.generateAuthUrl({
        access_type: 'offline',
        scope: scopeNamesToUrls(validateRequestedScopes(params.scopes)),
        prompt: 'consent',
        state: params.state,
    });
}

function normalizePublicBaseUrl(publicBaseUrl: string): string {
    const parsed = new URL(publicBaseUrl);
    parsed.search = '';
    parsed.hash = '';
    if (parsed.pathname.endsWith('/mcp')) {
        parsed.pathname = parsed.pathname.slice(0, -'/mcp'.length) || '/';
    }
    return parsed.toString().replace(/\/$/, '');
}

export function startRemoteGmailOAuthFlow(params: {
    accountEmail: string;
    scopes?: string[];
    publicBaseUrl: string;
    oauthPath?: string;
}): { authUrl: string; accountEmail: string; redirectUri: string; state: string; expiresAt: number } {
    const accountEmail = normalizeAccountEmail(params.accountEmail);
    const scopes = validateRequestedScopes(params.scopes || DEFAULT_SCOPES);
    const redirectUri = `${normalizePublicBaseUrl(params.publicBaseUrl)}/oauth2callback`;
    const state = createPendingGmailOAuthState({ accountEmail, scopes, redirectUri });
    const pending = pendingGmailOAuthStates.get(state);
    if (!pending) {
        throw new GmailOAuthError('invalid_state', 'Failed to create OAuth state.', 500);
    }

    return {
        authUrl: buildGmailAuthUrl({ scopes, redirectUri, state, oauthPath: params.oauthPath }),
        accountEmail,
        redirectUri,
        state,
        expiresAt: pending.expiresAt,
    };
}

export interface CompleteGmailOAuthCallbackDeps {
    exchangeCode?: (oauthClient: OAuth2Client, code: string) => Promise<Credentials>;
    getAuthenticatedEmail?: (oauthClient: OAuth2Client) => Promise<string | undefined>;
    saveCredentials?: (accountEmail: string, credentials: GmailCredentialsFile) => void;
}

async function exchangeCode(oauthClient: OAuth2Client, code: string): Promise<Credentials> {
    try {
        const { tokens } = await oauthClient.getToken(code);
        return tokens;
    } catch (error) {
        throw new GmailOAuthError(
            'token_exchange_failed',
            `Failed to exchange Google OAuth code: ${(error as Error).message}`,
            500,
        );
    }
}

async function getAuthenticatedEmail(oauthClient: OAuth2Client): Promise<string | undefined> {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauthClient });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return profile.data.emailAddress || undefined;
    } catch (error) {
        throw new GmailOAuthError(
            'profile_fetch_failed',
            `Failed to verify authenticated Gmail account: ${(error as Error).message}`,
            500,
        );
    }
}

export async function completeGmailOAuthCallback(params: {
    code?: string;
    state?: string;
    oauthPath?: string;
    deps?: CompleteGmailOAuthCallbackDeps;
}): Promise<{ accountEmail: string; scopes: string[] }> {
    if (!params.code) {
        throw new GmailOAuthError('missing_code', 'Missing Google OAuth code.');
    }

    const pending = consumePendingGmailOAuthState(params.state);
    const keys = loadOAuthKeys(params.oauthPath);
    const oauthClient = createGmailOAuthClient(pending.redirectUri, keys);
    const tokens = params.deps?.exchangeCode
        ? await params.deps.exchangeCode(oauthClient, params.code)
        : await exchangeCode(oauthClient, params.code);

    oauthClient.setCredentials(tokens);
    const authenticatedEmail = await (params.deps?.getAuthenticatedEmail
        ? params.deps.getAuthenticatedEmail(oauthClient)
        : getAuthenticatedEmail(oauthClient));

    if (!authenticatedEmail || normalizeAccountEmail(authenticatedEmail) !== pending.accountEmail) {
        throw new GmailOAuthError(
            'account_mismatch',
            `Authenticated Google account "${authenticatedEmail || 'unknown'}" does not match requested account "${pending.accountEmail}".`,
        );
    }

    const credentials = { tokens, scopes: pending.scopes };
    if (params.deps?.saveCredentials) {
        params.deps.saveCredentials(pending.accountEmail, credentials);
    } else {
        saveAccountCredentials(pending.accountEmail, credentials);
    }

    return {
        accountEmail: pending.accountEmail,
        scopes: pending.scopes,
    };
}

function getLocalCallbackPort(redirectUri: string): number {
    try {
        const parsed = new URL(redirectUri);
        if (parsed.port) return Number(parsed.port);
    } catch {
        // Fall through to the historical default.
    }
    return 3000;
}

async function verifyAccountIfRequested(
    oauthClient: OAuth2Client,
    requestedAccountEmail: string | undefined,
): Promise<void> {
    if (!requestedAccountEmail) return;

    const authenticatedEmail = await getAuthenticatedEmail(oauthClient);
    if (!authenticatedEmail || normalizeAccountEmail(authenticatedEmail) !== requestedAccountEmail) {
        throw new GmailOAuthError(
            'account_mismatch',
            `Authenticated Google account "${authenticatedEmail || 'unknown'}" does not match requested account "${requestedAccountEmail}".`,
        );
    }
}

export function startLocalGmailOAuthFlow(
    scopes: string[],
    accountEmail: string,
    redirectUri = LOCAL_GMAIL_CALLBACK_URL,
): string {
    const normalizedScopes = validateRequestedScopes(scopes);
    const normalizedAccountEmail = normalizeAccountEmail(accountEmail);
    const oauthClient = createGmailOAuthClient(redirectUri);
    const callbackPath = new URL(redirectUri).pathname || '/oauth2callback';
    const listenPort = getLocalCallbackPort(redirectUri);
    const authUrl = buildGmailAuthUrl({ scopes: normalizedScopes, redirectUri });
    const server = http.createServer();

    server.on('request', async (req, res) => {
        const requestUrl = new URL(req.url || '/', LOCAL_GMAIL_CALLBACK_URL);
        if (requestUrl.pathname !== callbackPath) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        const code = requestUrl.searchParams.get('code');
        if (!code) {
            res.writeHead(400);
            res.end('No code provided');
            server.close();
            return;
        }

        try {
            const tokens = await exchangeCode(oauthClient, code);
            oauthClient.setCredentials(tokens);
            await verifyAccountIfRequested(oauthClient, normalizedAccountEmail);

            const credentials = { tokens, scopes: normalizedScopes };
            saveAccountCredentials(normalizedAccountEmail, credentials);

            res.writeHead(200);
            res.end('Authentication successful! You can close this window.');
            console.log(`Successfully authenticated account ${normalizedAccountEmail} and saved credentials.`);
        } catch (error) {
            res.writeHead(error instanceof GmailOAuthError ? error.statusCode : 500);
            res.end('Authentication failed');
            console.error('OAuth authentication failed:', (error as Error).message);
        } finally {
            server.close();
        }
    });

    server.listen(listenPort, '127.0.0.1', () => {
        console.log('Requesting scopes:', normalizedScopes.join(', '));
        console.log(`Authenticating for account: ${normalizedAccountEmail}`);
        console.log('Using OAuth callback:', redirectUri);
        console.log('Please visit this URL to authenticate:', authUrl);
        open(authUrl).catch(error => {
            console.warn('Could not open browser automatically:', (error as Error).message);
        });
    });

    setTimeout(() => {
        server.close();
    }, GMAIL_OAUTH_STATE_TTL_MS);

    return authUrl;
}

export async function authenticate(
    scopes: string[],
    accountEmail?: string,
    redirectUri = LOCAL_GMAIL_CALLBACK_URL,
): Promise<void> {
    const normalizedScopes = validateRequestedScopes(scopes);
    const normalizedAccountEmail = accountEmail ? normalizeAccountEmail(accountEmail) : undefined;
    const oauthClient = createGmailOAuthClient(redirectUri);
    const callbackPath = new URL(redirectUri).pathname || '/oauth2callback';
    const listenPort = getLocalCallbackPort(redirectUri);
    const server = http.createServer();

    return new Promise<void>((resolve, reject) => {
        let settled = false;

        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            server.close();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        server.on('error', finish);
        server.on('request', async (req, res) => {
            const requestUrl = new URL(req.url || '/', LOCAL_GMAIL_CALLBACK_URL);
            if (requestUrl.pathname !== callbackPath) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const googleError = requestUrl.searchParams.get('error');
            if (googleError) {
                res.writeHead(400);
                res.end(`Authentication failed: ${googleError}`);
                finish(new GmailOAuthError('token_exchange_failed', `Google OAuth failed: ${googleError}`));
                return;
            }

            const code = requestUrl.searchParams.get('code');
            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                finish(new GmailOAuthError('missing_code', 'No code provided'));
                return;
            }

            try {
                const tokens = await exchangeCode(oauthClient, code);
                oauthClient.setCredentials(tokens);
                await verifyAccountIfRequested(oauthClient, normalizedAccountEmail);

                const credentials = { tokens, scopes: normalizedScopes };
                const targetCredPath = normalizedAccountEmail
                    ? saveAccountCredentials(normalizedAccountEmail, credentials)
                    : CREDENTIALS_PATH;

                if (!normalizedAccountEmail) {
                    saveCredentialsFile(targetCredPath, credentials);
                }

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                console.log('Credentials saved to:', targetCredPath);
                finish();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                res.writeHead(error instanceof GmailOAuthError ? error.statusCode : 500);
                res.end(`Authentication failed: ${message}`);
                finish(error);
            }
        });

        server.listen(listenPort, '127.0.0.1', () => {
            const authUrl = buildGmailAuthUrl({ scopes: normalizedScopes, redirectUri });
            console.log('Requesting scopes:', normalizedScopes.join(', '));
            if (normalizedAccountEmail) {
                console.log(`Authenticating for account: ${normalizedAccountEmail}`);
            }
            console.log('Using OAuth callback:', redirectUri);
            console.log('Please visit this URL to authenticate:', authUrl);
            open(authUrl).catch(error => {
                console.warn('Could not open browser automatically:', (error as Error).message);
            });
        });
    });
}
