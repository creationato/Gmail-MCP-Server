import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'fs';
import http from 'http';
import { isIP } from 'node:net';
import path from 'path';
import { gmail as createGmailClient } from '@googleapis/gmail';
import { OAuth2Client, Credentials } from 'google-auth-library';
import open from 'open';
import { DEFAULT_SCOPES, scopeNamesToUrls, validateScopes } from './scopes.js';
import {
    CONFIG_DIR,
    atomicWriteFile,
    canonicalizeAccountEmail,
    ensureDirectories,
    getAccountCredentialsPath,
} from './db.js';
import { getDefaultOAuthStateStore, OAuthStateStore } from './oauth-store.js';
import { withStateLockSync } from './state-lock.js';

export { CONFIG_DIR } from './db.js';
export const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
export const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');
export const LOCAL_GMAIL_CALLBACK_URL = 'http://localhost:3000/oauth2callback';

const GMAIL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

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
    | 'account_mismatch'
    | 'invalid_listen_host'
    | 'callback_outcome_uncertain';

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

function isValidListenHostname(host: string): boolean {
    if (host.length > 253 || host.endsWith('.')) return false;
    return host.split('.').every(label => (
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
}

export function getGmailOAuthListenHost(env: NodeJS.ProcessEnv = process.env): string {
    const host = env.GMAIL_OAUTH_LISTEN_HOST?.trim() || '127.0.0.1';
    if (isIP(host) === 0 && !isValidListenHostname(host)) {
        throw new GmailOAuthError(
            'invalid_listen_host',
            'GMAIL_OAUTH_LISTEN_HOST must be a valid IP address or DNS hostname without a scheme or port.',
            500,
        );
    }
    return host;
}

export function normalizeAccountEmail(email: string): string {
    try {
        return canonicalizeAccountEmail(email);
    } catch {
        throw new GmailOAuthError('invalid_account', 'Invalid Gmail account email address.');
    }
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
    withStateLockSync(() => {
        atomicWriteFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, 0o600);
    }, getOAuthFileLockDirectory(filePath));
}

export function saveAccountCredentials(accountEmail: string, credentials: GmailCredentialsFile): string {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    const targetCredPath = getAccountCredentialsPath(normalizedEmail);
    saveCredentialsFile(targetCredPath, credentials);
    return targetCredPath;
}

type GmailCallbackStatus = 'pending' | 'processing' | 'completed';

interface GmailCallbackJournalEntry {
    pending: PendingGmailOAuthState;
    status: GmailCallbackStatus;
    codeHash?: string;
    tokens?: Credentials;
    authoritativeStateConsumed?: boolean;
    updatedAt: number;
}

interface GmailCallbackJournal {
    version: 1;
    entries: Record<string, GmailCallbackJournalEntry>;
}

interface GmailCallbackAttempt {
    pending: PendingGmailOAuthState;
    tokens?: Credentials;
    authoritativeStateConsumed: boolean;
}

function hashOAuthValue(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function getCallbackJournalPath(store: OAuthStateStore): string {
    return `${store.databasePath}.gmail-callbacks.json`;
}

function getOAuthFileLockDirectory(filePath: string): string {
    const resolvedConfigDirectory = path.resolve(CONFIG_DIR);
    const resolvedFilePath = path.resolve(filePath);
    const relative = path.relative(resolvedConfigDirectory, resolvedFilePath);
    if (
        relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ) {
        return resolvedConfigDirectory;
    }
    return path.dirname(resolvedFilePath);
}

function readCallbackJournal(journalPath: string): GmailCallbackJournal {
    if (!fs.existsSync(journalPath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<GmailCallbackJournal>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error(`Invalid Gmail OAuth callback journal at ${journalPath}.`);
    }
    return parsed as GmailCallbackJournal;
}

function updateCallbackJournal<T>(
    store: OAuthStateStore,
    update: (journal: GmailCallbackJournal) => T,
): T {
    const journalPath = getCallbackJournalPath(store);
    return withStateLockSync(() => {
        const journal = readCallbackJournal(journalPath);
        const now = Date.now();
        for (const [stateHash, entry] of Object.entries(journal.entries)) {
            if (entry.pending.expiresAt <= now) delete journal.entries[stateHash];
        }
        const result = update(journal);
        atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
        return result;
    }, getOAuthFileLockDirectory(journalPath));
}

function registerCallbackState(
    store: OAuthStateStore,
    state: string,
    pending: PendingGmailOAuthState,
): void {
    updateCallbackJournal(store, journal => {
        journal.entries[hashOAuthValue(state)] = {
            pending,
            status: 'pending',
            authoritativeStateConsumed: false,
            updatedAt: Date.now(),
        };
    });
}

function createRecoverableGmailOAuthState(
    record: Omit<PendingGmailOAuthState, 'createdAt' | 'expiresAt'>,
    ttlMs: number,
    store: OAuthStateStore,
): { state: string; record: PendingGmailOAuthState } {
    const pending = store.createGmailOAuthState(record, ttlMs);
    try {
        registerCallbackState(store, pending.state, pending.record);
    } catch (error) {
        store.consumeGmailOAuthState(pending.state);
        throw error;
    }
    return pending;
}

function consumePendingGmailOAuthStateRaw(
    state: string,
    store: OAuthStateStore,
): PendingGmailOAuthState {
    const result = store.consumeGmailOAuthState(state);
    if (result.status !== 'valid') {
        if (result.status === 'expired') {
            throw new GmailOAuthError('expired_state', 'OAuth state has expired. Please start authentication again.');
        }
        throw new GmailOAuthError('invalid_state', 'OAuth state is invalid or has already been used.');
    }
    return result.record;
}

function markCallbackStateCompleted(store: OAuthStateStore, state: string): void {
    updateCallbackJournal(store, journal => {
        const entry = journal.entries[hashOAuthValue(state)];
        if (!entry) return;
        entry.status = 'completed';
        entry.updatedAt = Date.now();
        delete entry.tokens;
    });
}

function beginCallbackAttempt(
    store: OAuthStateStore,
    state: string,
    code: string,
): GmailCallbackAttempt {
    const stateHash = hashOAuthValue(state);
    const codeHash = hashOAuthValue(code);
    const fromJournal = updateCallbackJournal(store, journal => {
        const entry = journal.entries[stateHash];
        if (!entry) return undefined;
        if (entry.status === 'completed') {
            throw new GmailOAuthError('invalid_state', 'OAuth state is invalid or has already been used.');
        }
        if (entry.status === 'processing') {
            throw new GmailOAuthError(
                'callback_outcome_uncertain',
                'This OAuth callback is already processing or was interrupted with an uncertain outcome. Start authentication again if the first callback does not finish.',
                409,
            );
        }
        if (entry.codeHash && entry.codeHash !== codeHash) {
            throw new GmailOAuthError('invalid_state', 'OAuth state was already bound to a different callback code.');
        }

        entry.status = 'processing';
        entry.codeHash = codeHash;
        entry.updatedAt = Date.now();
        return {
            pending: { ...entry.pending, scopes: [...entry.pending.scopes] },
            tokens: entry.tokens ? { ...entry.tokens } : undefined,
            authoritativeStateConsumed: entry.authoritativeStateConsumed === true,
        };
    });
    if (fromJournal) return fromJournal;

    // States created before callback journaling are consumed once, then become
    // recoverable through the journal for subsequent handled failures.
    const pending = consumePendingGmailOAuthStateRaw(state, store);
    updateCallbackJournal(store, journal => {
        journal.entries[stateHash] = {
            pending,
            status: 'processing',
            codeHash,
            authoritativeStateConsumed: true,
            updatedAt: Date.now(),
        };
    });
    return { pending, authoritativeStateConsumed: true };
}

function storeCallbackTokens(
    store: OAuthStateStore,
    state: string,
    code: string,
    tokens: Credentials,
): void {
    updateCallbackJournal(store, journal => {
        const entry = journal.entries[hashOAuthValue(state)];
        if (
            !entry ||
            entry.status !== 'processing' ||
            entry.codeHash !== hashOAuthValue(code)
        ) {
            throw new GmailOAuthError(
                'callback_outcome_uncertain',
                'OAuth callback ownership changed while tokens were being persisted.',
                409,
            );
        }
        entry.tokens = { ...tokens };
        entry.updatedAt = Date.now();
    });
}

function makeCallbackRetryable(store: OAuthStateStore, state: string, code: string): void {
    updateCallbackJournal(store, journal => {
        const entry = journal.entries[hashOAuthValue(state)];
        if (
            !entry ||
            entry.status !== 'processing' ||
            entry.codeHash !== hashOAuthValue(code)
        ) {
            throw new GmailOAuthError(
                'callback_outcome_uncertain',
                'OAuth callback state could not be made retryable safely.',
                409,
            );
        }
        entry.status = 'pending';
        entry.updatedAt = Date.now();
    });
}

function finishCallbackAttempt(store: OAuthStateStore, state: string, code: string): void {
    updateCallbackJournal(store, journal => {
        const entry = journal.entries[hashOAuthValue(state)];
        if (
            !entry ||
            entry.status !== 'processing' ||
            entry.codeHash !== hashOAuthValue(code)
        ) {
            throw new GmailOAuthError(
                'callback_outcome_uncertain',
                'OAuth callback state could not be finalized safely.',
                409,
            );
        }
        entry.status = 'completed';
        entry.updatedAt = Date.now();
        delete entry.tokens;
    });
}

export function cleanupPendingGmailOAuthStates(store = getDefaultOAuthStateStore()): void {
    store.cleanupExpired();
    updateCallbackJournal(store, () => undefined);
}

export function createPendingGmailOAuthState(params: {
    accountEmail: string;
    scopes: string[];
    redirectUri: string;
    ttlMs?: number;
}, store = getDefaultOAuthStateStore()): string {
    const { state } = createRecoverableGmailOAuthState({
        accountEmail: normalizeAccountEmail(params.accountEmail),
        scopes: validateRequestedScopes(params.scopes),
        redirectUri: params.redirectUri,
    }, params.ttlMs ?? GMAIL_OAUTH_STATE_TTL_MS, store);
    return state;
}

export function consumePendingGmailOAuthState(
    state?: string,
    store = getDefaultOAuthStateStore(),
): PendingGmailOAuthState {
    if (!state) {
        throw new GmailOAuthError('missing_state', 'Missing OAuth state.');
    }
    markCallbackStateCompleted(store, state);
    return consumePendingGmailOAuthStateRaw(state, store);
}

export function buildGmailAuthUrl(params: {
    scopes: string[];
    redirectUri: string;
    state?: string;
    loginHint?: string;
    oauthPath?: string;
}): string {
    const keys = loadOAuthKeys(params.oauthPath);
    const oauthClient = createGmailOAuthClient(params.redirectUri, keys);
    return oauthClient.generateAuthUrl({
        access_type: 'offline',
        scope: scopeNamesToUrls(validateRequestedScopes(params.scopes)),
        prompt: 'consent',
        state: params.state,
        login_hint: params.loginHint,
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
    stateStore?: OAuthStateStore;
}): { authUrl: string; accountEmail: string; redirectUri: string; state: string; expiresAt: number } {
    const accountEmail = normalizeAccountEmail(params.accountEmail);
    const scopes = validateRequestedScopes(params.scopes || DEFAULT_SCOPES);
    const redirectUri = `${normalizePublicBaseUrl(params.publicBaseUrl)}/oauth2callback`;
    const store = params.stateStore ?? getDefaultOAuthStateStore();
    const pending = createRecoverableGmailOAuthState(
        { accountEmail, scopes, redirectUri },
        GMAIL_OAUTH_STATE_TTL_MS,
        store,
    );

    return {
        authUrl: buildGmailAuthUrl({ scopes, redirectUri, state: pending.state, oauthPath: params.oauthPath }),
        accountEmail,
        redirectUri,
        state: pending.state,
        expiresAt: pending.record.expiresAt,
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
        const gmail = createGmailClient({ version: 'v1', auth: oauthClient });
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
    stateStore?: OAuthStateStore;
    deps?: CompleteGmailOAuthCallbackDeps;
}): Promise<{ accountEmail: string; scopes: string[] }> {
    if (!params.code) {
        throw new GmailOAuthError('missing_code', 'Missing Google OAuth code.');
    }
    if (!params.state) {
        throw new GmailOAuthError('missing_state', 'Missing OAuth state.');
    }

    const store = params.stateStore ?? getDefaultOAuthStateStore();
    const attempt = beginCallbackAttempt(store, params.state, params.code);
    const pending = attempt.pending;
    let callbackFinished = false;
    let credentialsSaved = false;
    let codeExchanged = false;
    let tokensPersisted = attempt.tokens !== undefined;

    try {
        const keys = loadOAuthKeys(params.oauthPath);
        const oauthClient = createGmailOAuthClient(pending.redirectUri, keys);
        let tokens = attempt.tokens;
        if (!tokens) {
            tokens = params.deps?.exchangeCode
                ? await params.deps.exchangeCode(oauthClient, params.code)
                : await exchangeCode(oauthClient, params.code);
            codeExchanged = true;
            storeCallbackTokens(store, params.state, params.code, tokens);
            tokensPersisted = true;
        }

        oauthClient.setCredentials(tokens);
        const authenticatedEmail = await (params.deps?.getAuthenticatedEmail
            ? params.deps.getAuthenticatedEmail(oauthClient)
            : getAuthenticatedEmail(oauthClient));

        if (!authenticatedEmail || normalizeAccountEmail(authenticatedEmail) !== pending.accountEmail) {
            finishCallbackAttempt(store, params.state, params.code);
            callbackFinished = true;
            if (!attempt.authoritativeStateConsumed) {
                consumePendingGmailOAuthStateRaw(params.state, store);
            }
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
        credentialsSaved = true;

        finishCallbackAttempt(store, params.state, params.code);
        callbackFinished = true;
        if (!attempt.authoritativeStateConsumed) {
            consumePendingGmailOAuthStateRaw(params.state, store);
        }

        return {
            accountEmail: pending.accountEmail,
            scopes: pending.scopes,
        };
    } catch (error) {
        if (!callbackFinished && credentialsSaved) {
            throw new GmailOAuthError(
                'callback_outcome_uncertain',
                'Gmail credentials were saved, but callback finalization failed. Do not retry this callback; verify the account or start authentication again.',
                409,
            );
        }
        if (!callbackFinished && !credentialsSaved) {
            if (codeExchanged && !tokensPersisted) {
                throw new GmailOAuthError(
                    'callback_outcome_uncertain',
                    'Google returned OAuth tokens, but they could not be journaled durably. Do not retry this callback; start authentication again.',
                    409,
                );
            }
            makeCallbackRetryable(store, params.state, params.code);
        }
        throw error;
    }
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

export function validateLocalOAuthCallbackState(expected: string, received: string | null): void {
    if (!received) {
        throw new GmailOAuthError('missing_state', 'Missing OAuth state.');
    }
    const expectedHash = Buffer.from(hashOAuthValue(expected), 'hex');
    const receivedHash = Buffer.from(hashOAuthValue(received), 'hex');
    if (!timingSafeEqual(expectedHash, receivedHash)) {
        throw new GmailOAuthError('invalid_state', 'OAuth state does not match the active authentication request.');
    }
}

async function resolveAuthenticatedAccount(
    oauthClient: OAuth2Client,
    requestedAccountEmail: string | undefined,
): Promise<string> {
    const authenticatedEmail = await getAuthenticatedEmail(oauthClient);
    if (!authenticatedEmail) {
        throw new GmailOAuthError('profile_fetch_failed', 'Google did not return an authenticated Gmail account.');
    }
    const normalizedAuthenticatedEmail = normalizeAccountEmail(authenticatedEmail);
    if (requestedAccountEmail && normalizedAuthenticatedEmail !== requestedAccountEmail) {
        throw new GmailOAuthError(
            'account_mismatch',
            `Authenticated Google account "${authenticatedEmail || 'unknown'}" does not match requested account "${requestedAccountEmail}".`,
        );
    }
    return normalizedAuthenticatedEmail;
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
    const listenHost = getGmailOAuthListenHost();
    const expectedState = randomBytes(32).toString('base64url');
    const authUrl = buildGmailAuthUrl({
        scopes: normalizedScopes,
        redirectUri,
        state: expectedState,
        loginHint: normalizedAccountEmail,
    });
    const server = http.createServer();

    server.on('request', async (req, res) => {
        const requestUrl = new URL(req.url || '/', LOCAL_GMAIL_CALLBACK_URL);
        if (requestUrl.pathname !== callbackPath) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        try {
            validateLocalOAuthCallbackState(expectedState, requestUrl.searchParams.get('state'));
        } catch (error) {
            res.writeHead(error instanceof GmailOAuthError ? error.statusCode : 400);
            res.end('Authentication failed: invalid OAuth state');
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
            await resolveAuthenticatedAccount(oauthClient, normalizedAccountEmail);

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

    server.listen(listenPort, listenHost, () => {
        console.log('Requesting scopes:', normalizedScopes.join(', '));
        console.log(`Authenticating for account: ${normalizedAccountEmail}`);
        console.log('Using OAuth callback:', redirectUri);
        console.log(`Listening for the OAuth callback on ${listenHost}:${listenPort}`);
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
    const listenHost = getGmailOAuthListenHost();
    const expectedState = randomBytes(32).toString('base64url');
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

            try {
                validateLocalOAuthCallbackState(expectedState, requestUrl.searchParams.get('state'));
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Invalid OAuth state';
                res.writeHead(error instanceof GmailOAuthError ? error.statusCode : 400);
                res.end(`Authentication failed: ${message}`);
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
                const authenticatedAccountEmail = await resolveAuthenticatedAccount(
                    oauthClient,
                    normalizedAccountEmail,
                );

                const credentials = { tokens, scopes: normalizedScopes };
                const targetCredPath = saveAccountCredentials(authenticatedAccountEmail, credentials);

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

        server.listen(listenPort, listenHost, () => {
            const authUrl = buildGmailAuthUrl({
                scopes: normalizedScopes,
                redirectUri,
                state: expectedState,
                loginHint: normalizedAccountEmail,
            });
            console.log('Requesting scopes:', normalizedScopes.join(', '));
            if (normalizedAccountEmail) {
                console.log(`Authenticating for account: ${normalizedAccountEmail}`);
            }
            console.log('Using OAuth callback:', redirectUri);
            console.log(`Listening for the OAuth callback on ${listenHost}:${listenPort}`);
            console.log('Please visit this URL to authenticate:', authUrl);
            open(authUrl).catch(error => {
                console.warn('Could not open browser automatically:', (error as Error).message);
            });
        });
    });
}
