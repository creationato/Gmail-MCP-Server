import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureStateDirectory, getStateDatabasePath } from './state.js';

const SCHEMA_VERSION = 3;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const OAUTH_REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const MAX_OAUTH_REGISTRATIONS_PER_WINDOW = 12;
export const MAX_OAUTH_CLIENTS = 100;
const MAX_OAUTH_REGISTRATION_EVENTS = 1000;

export class OAuthClientLimitError extends Error {
    constructor(message = `OAuth client registration limit (${MAX_OAUTH_CLIENTS}) reached.`) {
        super(message);
        this.name = 'OAuthClientLimitError';
    }
}

export interface RegisteredOAuthClient {
    clientId: string;
    redirectUris: string[];
    clientName?: string;
    createdAt: number;
}

export interface PendingAuthorizationCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    audience: string;
    expiresAt: number;
}

export interface RemoteTokenResponse {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    scope: string;
}

export interface PendingGmailOAuthStateRecord {
    accountEmail: string;
    scopes: string[];
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
}

type TokenRow = {
    client_id: string;
    scope: string;
    audience: string;
    expires_at: number;
    family_id: string;
};

type AuthorizationCodeRow = TokenRow & {
    redirect_uri: string;
    code_challenge: string;
};

type GmailStateRow = {
    account_email: string;
    scopes: string;
    redirect_uri: string;
    created_at: number;
    expires_at: number;
};

function hashSecret(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function pkceS256(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

function randomToken(): string {
    return randomBytes(32).toString('base64url');
}

export class OAuthStateStore {
    private readonly database: DatabaseSync;

    constructor(public readonly databasePath = getStateDatabasePath()) {
        ensureStateDirectory(path.dirname(databasePath));
        this.database = new DatabaseSync(databasePath);
        fs.chmodSync(databasePath, 0o600);
        this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
        this.initializeSchema();
    }

    private initializeSchema(): void {
        const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
        if (row.user_version > SCHEMA_VERSION) {
            throw new Error(
                `Unsupported Gmail MCP state schema version ${row.user_version}; expected ${SCHEMA_VERSION}.`,
            );
        }
        if (row.user_version === SCHEMA_VERSION) return;

        this.database.exec('BEGIN IMMEDIATE');
        try {
            this.database.exec(`
                CREATE TABLE IF NOT EXISTS oauth_clients (
                    client_id TEXT PRIMARY KEY,
                    redirect_uris TEXT NOT NULL,
                    client_name TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authorization_codes (
                    secret_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    code_challenge TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    audience TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS access_tokens (
                    secret_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    audience TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    family_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    secret_hash TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    audience TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    family_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS refresh_token_history (
                    secret_hash TEXT PRIMARY KEY,
                    family_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS gmail_oauth_states (
                    secret_hash TEXT PRIMARY KEY,
                    account_email TEXT NOT NULL,
                    scopes TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS oauth_registration_events (
                    source_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
            `);

            for (const table of ['access_tokens', 'refresh_tokens']) {
                const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
                if (!columns.some(column => column.name === 'family_id')) {
                    this.database.exec(
                        `ALTER TABLE ${table} ADD COLUMN family_id TEXT NOT NULL DEFAULT ''`,
                    );
                }
            }

            // Schema-v1 issued access/refresh pairs in the same transaction and
            // therefore with identical ownership, audience, scope, and timestamp.
            // Reconstruct those families before assigning isolated fallbacks.
            this.database.exec(`
                UPDATE access_tokens
                SET family_id = 'legacy:' || secret_hash
                WHERE family_id = '';
                UPDATE refresh_tokens AS refresh
                SET family_id = COALESCE(
                    (
                        SELECT access.family_id
                        FROM access_tokens AS access
                        WHERE access.client_id = refresh.client_id
                          AND access.scope = refresh.scope
                          AND access.audience = refresh.audience
                          AND access.created_at = refresh.created_at
                        ORDER BY access.secret_hash
                        LIMIT 1
                    ),
                    'legacy:' || refresh.secret_hash
                )
                WHERE family_id = '';
            `);

            this.database.exec(`
                CREATE INDEX IF NOT EXISTS authorization_codes_expiry ON authorization_codes(expires_at);
                CREATE INDEX IF NOT EXISTS access_tokens_expiry ON access_tokens(expires_at);
                CREATE INDEX IF NOT EXISTS access_tokens_family ON access_tokens(family_id);
                CREATE INDEX IF NOT EXISTS refresh_tokens_expiry ON refresh_tokens(expires_at);
                CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens(family_id);
                CREATE INDEX IF NOT EXISTS refresh_token_history_expiry ON refresh_token_history(expires_at);
                CREATE INDEX IF NOT EXISTS gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
                CREATE INDEX IF NOT EXISTS oauth_registration_events_source_time
                    ON oauth_registration_events(source_hash, created_at);
                PRAGMA user_version = 3;
                COMMIT;
            `);
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            this.database.exec('COMMIT');
            return result;
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }

    cleanupExpired(now = Date.now()): void {
        this.transaction(() => {
            this.database.prepare('DELETE FROM authorization_codes WHERE expires_at <= ?').run(now);
            this.database.prepare('DELETE FROM access_tokens WHERE expires_at <= ?').run(now);
            this.database.prepare('DELETE FROM refresh_tokens WHERE expires_at <= ?').run(now);
            this.database.prepare('DELETE FROM refresh_token_history WHERE expires_at <= ?').run(now);
            this.database.prepare('DELETE FROM gmail_oauth_states WHERE expires_at <= ?').run(now);
            this.database.prepare('DELETE FROM oauth_registration_events WHERE created_at <= ?')
                .run(now - OAUTH_REGISTRATION_WINDOW_MS);
            this.database.prepare(`
                DELETE FROM oauth_clients
                WHERE created_at <= ?
                  AND client_id NOT IN (SELECT client_id FROM authorization_codes)
                  AND client_id NOT IN (SELECT client_id FROM access_tokens)
                  AND client_id NOT IN (SELECT client_id FROM refresh_tokens)
            `).run(now - OAUTH_CLIENT_TTL_MS);
        });
    }

    registerClient(
        redirectUris: string[],
        clientName?: string,
        now = Date.now(),
        registrationSource = 'unknown',
    ): RegisteredOAuthClient {
        const canonicalRedirectUris = [...new Set(redirectUris)].sort();
        const redirectsJson = JSON.stringify(canonicalRedirectUris);
        const normalizedName = clientName?.trim() || undefined;
        const sourceHash = hashSecret(registrationSource.trim().slice(0, 256) || 'unknown');
        return this.transaction(() => {
            this.database.prepare('DELETE FROM oauth_registration_events WHERE created_at <= ?')
                .run(now - OAUTH_REGISTRATION_WINDOW_MS);
            this.database.prepare(`
                DELETE FROM oauth_clients
                WHERE created_at <= ?
                  AND client_id NOT IN (SELECT client_id FROM authorization_codes WHERE expires_at > ?)
                  AND client_id NOT IN (SELECT client_id FROM access_tokens WHERE expires_at > ?)
                  AND client_id NOT IN (SELECT client_id FROM refresh_tokens WHERE expires_at > ?)
            `).run(now - OAUTH_CLIENT_TTL_MS, now, now, now);

            const existing = this.database.prepare(`
                SELECT client_id, redirect_uris, client_name, created_at
                FROM oauth_clients
                WHERE redirect_uris = ? AND client_name IS ?
                ORDER BY created_at DESC LIMIT 1
            `).get(redirectsJson, normalizedName ?? null) as {
                client_id: string;
                redirect_uris: string;
                client_name: string | null;
                created_at: number;
            } | undefined;
            if (existing) {
                return {
                    clientId: existing.client_id,
                    redirectUris: JSON.parse(existing.redirect_uris) as string[],
                    clientName: existing.client_name ?? undefined,
                    createdAt: existing.created_at,
                };
            }

            const recent = this.database.prepare(`
                SELECT COUNT(*) AS count
                FROM oauth_registration_events
                WHERE source_hash = ? AND created_at > ?
            `).get(sourceHash, now - OAUTH_REGISTRATION_WINDOW_MS) as { count: number };
            if (recent.count >= MAX_OAUTH_REGISTRATIONS_PER_WINDOW) {
                throw new OAuthClientLimitError(
                    'OAuth client registration rate limit reached; retry later.',
                );
            }

            let count = this.database.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get() as { count: number };
            const overflow = count.count - MAX_OAUTH_CLIENTS + 1;
            if (overflow > 0) {
                this.database.prepare(`
                    DELETE FROM oauth_clients
                    WHERE client_id IN (
                        SELECT client.client_id
                        FROM oauth_clients AS client
                        WHERE client.client_id NOT IN (
                            SELECT client_id FROM authorization_codes WHERE expires_at > ?
                        )
                          AND client.client_id NOT IN (
                            SELECT client_id FROM access_tokens WHERE expires_at > ?
                        )
                          AND client.client_id NOT IN (
                            SELECT client_id FROM refresh_tokens WHERE expires_at > ?
                        )
                        ORDER BY client.created_at ASC
                        LIMIT ?
                    )
                `).run(now, now, now, overflow);
                count = this.database.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get() as { count: number };
            }
            if (count.count >= MAX_OAUTH_CLIENTS) throw new OAuthClientLimitError();

            const client: RegisteredOAuthClient = {
                clientId: `client_${randomUUID()}`,
                redirectUris: canonicalRedirectUris,
                clientName: normalizedName,
                createdAt: now,
            };
            this.database.prepare(`
                INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at)
                VALUES (?, ?, ?, ?)
            `).run(client.clientId, redirectsJson, client.clientName ?? null, client.createdAt);
            this.database.prepare(`
                INSERT INTO oauth_registration_events (source_hash, created_at)
                VALUES (?, ?)
            `).run(sourceHash, now);
            this.database.prepare(`
                DELETE FROM oauth_registration_events
                WHERE rowid IN (
                    SELECT rowid FROM oauth_registration_events
                    ORDER BY created_at DESC, rowid DESC
                    LIMIT -1 OFFSET ?
                )
            `).run(MAX_OAUTH_REGISTRATION_EVENTS);
            return client;
        });
    }

    getClient(clientId: string): RegisteredOAuthClient | undefined {
        const row = this.database.prepare(`
            SELECT client_id, redirect_uris, client_name, created_at
            FROM oauth_clients WHERE client_id = ?
        `).get(clientId) as {
            client_id: string;
            redirect_uris: string;
            client_name: string | null;
            created_at: number;
        } | undefined;
        if (!row) return undefined;
        return {
            clientId: row.client_id,
            redirectUris: JSON.parse(row.redirect_uris) as string[],
            clientName: row.client_name ?? undefined,
            createdAt: row.created_at,
        };
    }

    createAuthorizationCode(record: PendingAuthorizationCode): string {
        const code = randomToken();
        this.database.prepare(`
            INSERT INTO authorization_codes (
                secret_hash, client_id, redirect_uri, code_challenge, scope, audience, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            hashSecret(code),
            record.clientId,
            record.redirectUri,
            record.codeChallenge,
            record.scope,
            record.audience,
            record.expiresAt,
        );
        return code;
    }

    exchangeAuthorizationCode(params: {
        code: string;
        clientId: string;
        redirectUri: string;
        codeVerifier: string;
        audience: string;
        now?: number;
    }): RemoteTokenResponse | undefined {
        const now = params.now ?? Date.now();
        return this.transaction(() => {
            const codeHash = hashSecret(params.code);
            const row = this.database.prepare(`
                SELECT client_id, redirect_uri, code_challenge, scope, audience, expires_at
                FROM authorization_codes WHERE secret_hash = ?
            `).get(codeHash) as AuthorizationCodeRow | undefined;
            if (!row || row.expires_at <= now) {
                if (row) this.database.prepare('DELETE FROM authorization_codes WHERE secret_hash = ?').run(codeHash);
                return undefined;
            }
            if (
                row.client_id !== params.clientId ||
                row.redirect_uri !== params.redirectUri ||
                row.audience !== params.audience ||
                !params.codeVerifier ||
                pkceS256(params.codeVerifier) !== row.code_challenge
            ) {
                return undefined;
            }

            this.database.prepare('DELETE FROM authorization_codes WHERE secret_hash = ?').run(codeHash);
            return this.issueTokens(row.client_id, row.scope, row.audience, now, randomUUID());
        });
    }

    rotateRefreshToken(params: {
        refreshToken: string;
        clientId: string;
        audience: string;
        now?: number;
    }): RemoteTokenResponse | undefined {
        const now = params.now ?? Date.now();
        return this.transaction(() => {
            const tokenHash = hashSecret(params.refreshToken);
            const row = this.database.prepare(`
                SELECT client_id, scope, audience, expires_at, family_id
                FROM refresh_tokens WHERE secret_hash = ?
            `).get(tokenHash) as TokenRow | undefined;
            if (!row) {
                const replay = this.database.prepare(`
                    SELECT family_id, expires_at FROM refresh_token_history
                    WHERE secret_hash = ?
                `).get(tokenHash) as { family_id: string; expires_at: number } | undefined;
                if (replay && replay.expires_at > now) this.revokeTokenFamily(replay.family_id);
                return undefined;
            }
            if (row.expires_at <= now) {
                if (row) this.database.prepare('DELETE FROM refresh_tokens WHERE secret_hash = ?').run(tokenHash);
                return undefined;
            }
            if (params.clientId !== row.client_id || params.audience !== row.audience) {
                return undefined;
            }
            this.database.prepare(`
                INSERT OR REPLACE INTO refresh_token_history (secret_hash, family_id, expires_at)
                VALUES (?, ?, ?)
            `).run(tokenHash, row.family_id, row.expires_at);
            this.database.prepare('DELETE FROM refresh_tokens WHERE secret_hash = ?').run(tokenHash);
            return this.issueTokens(row.client_id, row.scope, row.audience, now, row.family_id);
        });
    }

    private issueTokens(
        clientId: string,
        scope: string,
        audience: string,
        now: number,
        familyId: string,
    ): RemoteTokenResponse {
        const accessToken = randomToken();
        const refreshToken = randomToken();
        this.database.prepare(`
            INSERT INTO access_tokens (
                secret_hash, client_id, scope, audience, expires_at, created_at, family_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hashSecret(accessToken), clientId, scope, audience, now + ACCESS_TOKEN_TTL_MS, now, familyId);
        this.database.prepare(`
            INSERT INTO refresh_tokens (
                secret_hash, client_id, scope, audience, expires_at, created_at, family_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hashSecret(refreshToken), clientId, scope, audience, now + REFRESH_TOKEN_TTL_MS, now, familyId);
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'Bearer',
            expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
            scope,
        };
    }

    verifyAccessToken(accessToken: string, audience: string, now = Date.now()): boolean {
        const tokenHash = hashSecret(accessToken);
        const row = this.database.prepare(`
            SELECT audience, expires_at FROM access_tokens WHERE secret_hash = ?
        `).get(tokenHash) as { audience: string; expires_at: number } | undefined;
        if (!row) return false;
        if (row.expires_at <= now) {
            this.database.prepare('DELETE FROM access_tokens WHERE secret_hash = ?').run(tokenHash);
            return false;
        }
        return row.audience === audience;
    }

    revokeToken(token: string, clientId: string): void {
        this.transaction(() => {
            const tokenHash = hashSecret(token);
            const family = this.database.prepare(`
                SELECT family_id, client_id FROM refresh_tokens WHERE secret_hash = ?
                UNION ALL
                SELECT family_id, client_id FROM access_tokens WHERE secret_hash = ?
                LIMIT 1
            `).get(tokenHash, tokenHash) as { family_id: string; client_id: string } | undefined;
            if (family?.client_id === clientId) this.revokeTokenFamily(family.family_id);
        });
    }

    private revokeTokenFamily(familyId: string): void {
        this.database.prepare('DELETE FROM access_tokens WHERE family_id = ?').run(familyId);
        this.database.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').run(familyId);
        this.database.prepare('DELETE FROM refresh_token_history WHERE family_id = ?').run(familyId);
    }

    createGmailOAuthState(
        record: Omit<PendingGmailOAuthStateRecord, 'createdAt' | 'expiresAt'>,
        ttlMs: number,
        now = Date.now(),
    ): { state: string; record: PendingGmailOAuthStateRecord } {
        const state = randomToken();
        const pending: PendingGmailOAuthStateRecord = {
            ...record,
            createdAt: now,
            expiresAt: now + ttlMs,
        };
        this.database.prepare(`
            INSERT INTO gmail_oauth_states (
                secret_hash, account_email, scopes, redirect_uri, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            hashSecret(state),
            pending.accountEmail,
            JSON.stringify(pending.scopes),
            pending.redirectUri,
            pending.createdAt,
            pending.expiresAt,
        );
        return { state, record: pending };
    }

    consumeGmailOAuthState(
        state: string,
        now = Date.now(),
    ): { status: 'valid'; record: PendingGmailOAuthStateRecord } | { status: 'missing' | 'expired' } {
        return this.transaction(() => {
            const stateHash = hashSecret(state);
            const row = this.database.prepare(`
                SELECT account_email, scopes, redirect_uri, created_at, expires_at
                FROM gmail_oauth_states WHERE secret_hash = ?
            `).get(stateHash) as GmailStateRow | undefined;
            if (!row) return { status: 'missing' };

            this.database.prepare('DELETE FROM gmail_oauth_states WHERE secret_hash = ?').run(stateHash);
            if (row.expires_at <= now) return { status: 'expired' };
            return {
                status: 'valid',
                record: {
                    accountEmail: row.account_email,
                    scopes: JSON.parse(row.scopes) as string[],
                    redirectUri: row.redirect_uri,
                    createdAt: row.created_at,
                    expiresAt: row.expires_at,
                },
            };
        });
    }

    isReady(): boolean {
        const row = this.database.prepare('SELECT 1 AS ready').get() as { ready: number };
        return row.ready === 1;
    }

    close(): void {
        this.database.close();
    }
}

let defaultStore: OAuthStateStore | undefined;
let defaultStorePath: string | undefined;

export function getDefaultOAuthStateStore(): OAuthStateStore {
    const databasePath = getStateDatabasePath();
    if (!defaultStore || defaultStorePath !== databasePath) {
        defaultStore?.close();
        defaultStore = new OAuthStateStore(databasePath);
        defaultStorePath = databasePath;
    }
    return defaultStore;
}

export function closeDefaultOAuthStateStore(): void {
    defaultStore?.close();
    defaultStore = undefined;
    defaultStorePath = undefined;
}
