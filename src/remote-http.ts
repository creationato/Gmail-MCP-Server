import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { GmailOAuthError } from './gmail-oauth.js';
import { OAuthClientLimitError, OAuthStateStore } from './oauth-store.js';

export const REMOTE_MCP_SCOPE = 'gmail';
export const MCP_JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
export const MCP_IN_FLIGHT_BODY_BUDGET_BYTES = MCP_JSON_BODY_LIMIT_BYTES;
export const MCP_MAX_IN_FLIGHT_REQUESTS = 4;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MCP_BUSY_RETRY_AFTER_SECONDS = 1;

export interface RemoteServerConfig {
    apiKey: string;
    publicOrigin: string;
    basePath: string;
    issuerUrl: string;
    mcpPath: string;
    resourceUrl: string;
    authorizePath: string;
    tokenPath: string;
    revokePath: string;
    registerPath: string;
    googleCallbackPath: string;
    protectedResourceMetadataPath: string;
    authorizationServerMetadataPath: string;
    callbackAllowlist: ReadonlySet<string>;
}

export class RemoteConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RemoteConfigurationError';
    }
}

function normalizeBasePath(value: string | undefined): string {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === '/') return '';
    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const normalized = withLeadingSlash.replace(/\/+$/, '');
    if (!/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(normalized)) {
        throw new RemoteConfigurationError('GMAIL_MCP_BASE_PATH must contain only URL-safe path segments.');
    }
    if (normalized.endsWith('/mcp')) {
        throw new RemoteConfigurationError('GMAIL_MCP_BASE_PATH is a prefix and must not include the final /mcp segment.');
    }
    return normalized;
}

function parsePublicUrl(raw: string, variableName: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new RemoteConfigurationError(`${variableName} must be an absolute HTTP(S) URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new RemoteConfigurationError(`${variableName} must be a clean HTTP(S) URL without credentials, query, or fragment.`);
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) {
        throw new RemoteConfigurationError(`${variableName} must use HTTPS unless it targets loopback.`);
    }
    return url;
}

function parseCallbackAllowlist(raw: string | undefined): ReadonlySet<string> {
    const entries = raw?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    if (entries.length === 0) {
        throw new RemoteConfigurationError('GMAIL_MCP_OAUTH_CALLBACKS must list at least one allowed OAuth redirect URI.');
    }

    const callbacks = new Set<string>();
    for (const entry of entries) {
        const url = parsePublicUrl(entry, 'GMAIL_MCP_OAUTH_CALLBACKS');
        callbacks.add(url.toString());
    }
    return callbacks;
}

export function loadRemoteServerConfig(env: NodeJS.ProcessEnv = process.env): RemoteServerConfig {
    const apiKey = env.GMAIL_MCP_API_KEY?.trim();
    if (!apiKey || Buffer.byteLength(apiKey, 'utf8') < 32) {
        throw new RemoteConfigurationError(
            'GMAIL_MCP_API_KEY is required in remote mode and must be at least 32 bytes.',
        );
    }

    const explicitOrigin = env.GMAIL_MCP_PUBLIC_ORIGIN?.trim();
    const legacyPublicUrl = (env.GMAIL_MCP_PUBLIC_URL || env.MCP_PUBLIC_URL)?.trim();
    if (!explicitOrigin && !legacyPublicUrl) {
        throw new RemoteConfigurationError(
            'GMAIL_MCP_PUBLIC_ORIGIN or the compatible GMAIL_MCP_PUBLIC_URL setting is required in remote mode.',
        );
    }

    let publicOrigin: string;
    let inferredBasePath = '';
    if (explicitOrigin) {
        const originUrl = parsePublicUrl(explicitOrigin, 'GMAIL_MCP_PUBLIC_ORIGIN');
        if (originUrl.pathname !== '/' && originUrl.pathname !== '') {
            throw new RemoteConfigurationError('GMAIL_MCP_PUBLIC_ORIGIN must not contain a path; use GMAIL_MCP_BASE_PATH.');
        }
        publicOrigin = originUrl.origin;
    } else {
        const legacyUrl = parsePublicUrl(legacyPublicUrl!, 'GMAIL_MCP_PUBLIC_URL');
        publicOrigin = legacyUrl.origin;
        let legacyPath = legacyUrl.pathname.replace(/\/+$/, '');
        if (legacyPath.endsWith('/mcp')) legacyPath = legacyPath.slice(0, -'/mcp'.length);
        inferredBasePath = normalizeBasePath(legacyPath);
    }

    const basePath = env.GMAIL_MCP_BASE_PATH !== undefined
        ? normalizeBasePath(env.GMAIL_MCP_BASE_PATH)
        : inferredBasePath;
    const issuerUrl = `${publicOrigin}${basePath}`;
    const mcpPath = `${basePath}/mcp`;

    return {
        apiKey,
        publicOrigin,
        basePath,
        issuerUrl,
        mcpPath,
        resourceUrl: `${publicOrigin}${mcpPath}`,
        authorizePath: `${basePath}/authorize`,
        tokenPath: `${basePath}/token`,
        revokePath: `${basePath}/revoke`,
        registerPath: `${basePath}/register`,
        googleCallbackPath: `${basePath}/oauth2callback`,
        protectedResourceMetadataPath: `/.well-known/oauth-protected-resource${mcpPath}`,
        authorizationServerMetadataPath: `/.well-known/oauth-authorization-server${basePath}`,
        callbackAllowlist: parseCallbackAllowlist(env.GMAIL_MCP_OAUTH_CALLBACKS),
    };
}

function queryValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function extractBearerToken(req: express.Request): string | undefined {
    const authorization = req.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length).trim();
    return token || undefined;
}

function timingSafeStringEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function noStore(res: express.Response): express.Response {
    return res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
}

function sendOAuthError(res: express.Response, status: number, error: string, description: string): void {
    noStore(res).status(status).json({ error, error_description: description });
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char] ?? char);
}

function renderAuthorizeForm(action: string, params: Record<string, string>, error?: string): string {
    const hiddenInputs = Object.entries(params)
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join('\n');
    const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Gmail MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #1f2937; }
    label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.7rem; border: 1px solid #9ca3af; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.65rem 0.9rem; border: 0; border-radius: 6px; background: #1f2937; color: white; font-weight: 600; cursor: pointer; }
    .error { color: #b91c1c; font-weight: 600; }
    .hint { color: #4b5563; font-size: 0.95rem; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>Authorize Gmail MCP</h1>
  <p class="hint">Enter the server API key to allow this connector to use the Gmail MCP server.</p>
  ${errorMarkup}
  <form method="post" action="${escapeHtml(action)}">
    ${hiddenInputs}
    <label for="api_key">Server API key</label>
    <input id="api_key" name="api_key" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function renderGmailOAuthResultPage(success: boolean, message: string): string {
    const title = success ? 'Gmail authentication successful' : 'Gmail authentication failed';
    const color = success ? '#166534' : '#b91c1c';
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#1f2937">
  <h1 style="color:${color}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function oauthAuthorizationServerMetadata(config: RemoteServerConfig) {
    return {
        issuer: config.issuerUrl,
        authorization_endpoint: `${config.issuerUrl}/authorize`,
        token_endpoint: `${config.issuerUrl}/token`,
        revocation_endpoint: `${config.issuerUrl}/revoke`,
        registration_endpoint: `${config.issuerUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [REMOTE_MCP_SCOPE, 'offline_access'],
    };
}

function protectedResourceMetadata(config: RemoteServerConfig) {
    return {
        resource: config.resourceUrl,
        authorization_servers: [config.issuerUrl],
        bearer_methods_supported: ['header'],
        scopes_supported: [REMOTE_MCP_SCOPE],
    };
}

type AuthorizeParams = {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    state: string;
    code_challenge: string;
    code_challenge_method: string;
    resource: string;
};

function readAuthorizeParams(source: Record<string, unknown>, config: RemoteServerConfig): AuthorizeParams {
    return {
        response_type: queryValue(source.response_type) || '',
        client_id: queryValue(source.client_id) || '',
        redirect_uri: queryValue(source.redirect_uri) || '',
        scope: queryValue(source.scope) || REMOTE_MCP_SCOPE,
        state: queryValue(source.state) || '',
        code_challenge: queryValue(source.code_challenge) || '',
        code_challenge_method: queryValue(source.code_challenge_method) || '',
        resource: queryValue(source.resource) || config.resourceUrl,
    };
}

function validateAuthorizeParams(
    params: AuthorizeParams,
    config: RemoteServerConfig,
    store: OAuthStateStore,
): string | undefined {
    if (params.response_type !== 'code') return 'Unsupported response_type.';
    const client = store.getClient(params.client_id);
    if (!client) return 'Unknown OAuth client.';
    if (!client.redirectUris.includes(params.redirect_uri)) return 'redirect_uri is not registered for this OAuth client.';
    if (params.resource !== config.resourceUrl) return 'The requested resource does not match this MCP server.';
    const scopes = params.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes(REMOTE_MCP_SCOPE) || scopes.some(scope => ![REMOTE_MCP_SCOPE, 'offline_access'].includes(scope))) {
        return 'Unsupported scope.';
    }
    if (!params.code_challenge || params.code_challenge_method !== 'S256') return 'PKCE S256 is required.';
    return undefined;
}

function sendRemoteAuthChallenge(config: RemoteServerConfig, res: express.Response): void {
    const metadataUrl = `${config.publicOrigin}${config.protectedResourceMetadataPath}`;
    res.status(401)
        .set('WWW-Authenticate',
            `Bearer error="invalid_token", error_description="Authentication required", resource_metadata="${metadataUrl}", scope="${REMOTE_MCP_SCOPE}"`,
        )
        .json({ error: 'invalid_token', error_description: 'Authentication required' });
}

type ContentLength =
    | { kind: 'missing' }
    | { kind: 'invalid' }
    | { kind: 'oversized' }
    | { kind: 'valid'; bytes: number };

type McpHttpFailure = {
    status: number;
    error: string;
    description: string;
    details?: Record<string, number | string>;
};

class McpInFlightBudget {
    private activeRequests = 0;
    private reservedBytes = 0;

    tryAcquire(reservationBytes: number): (() => void) | undefined {
        if (
            !Number.isSafeInteger(reservationBytes)
            || reservationBytes < 0
            || reservationBytes > MCP_IN_FLIGHT_BODY_BUDGET_BYTES
            || this.activeRequests >= MCP_MAX_IN_FLIGHT_REQUESTS
            || this.reservedBytes > MCP_IN_FLIGHT_BODY_BUDGET_BYTES - reservationBytes
        ) {
            return undefined;
        }

        this.activeRequests += 1;
        this.reservedBytes += reservationBytes;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.activeRequests -= 1;
            this.reservedBytes -= reservationBytes;
        };
    }
}

function readContentLength(req: express.Request): ContentLength {
    const raw = req.get('content-length');
    if (raw === undefined) return { kind: 'missing' };
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return { kind: 'invalid' };
    const bytes = Number(raw);
    if (!Number.isSafeInteger(bytes)) return { kind: 'oversized' };
    if (bytes > MCP_JSON_BODY_LIMIT_BYTES) return { kind: 'oversized' };
    return { kind: 'valid', bytes };
}

function requestHasBody(req: express.Request, contentLength: ContentLength): boolean {
    return req.method === 'POST'
        || req.get('transfer-encoding') !== undefined
        || (contentLength.kind === 'valid' && contentLength.bytes > 0);
}

function bodyReservationBytes(req: express.Request, contentLength: ContentLength): number {
    if (!requestHasBody(req, contentLength)) return 0;
    const encoding = req.get('content-encoding')?.trim().toLowerCase();
    // Chunked, compressed, and otherwise unknown-length requests reserve the
    // full parser allowance because their decoded size is not known at admission.
    if (
        req.get('transfer-encoding') !== undefined
        || contentLength.kind === 'missing'
        || (encoding !== undefined && encoding !== 'identity')
    ) {
        return MCP_JSON_BODY_LIMIT_BYTES;
    }
    return contentLength.kind === 'valid' ? contentLength.bytes : MCP_JSON_BODY_LIMIT_BYTES;
}

function discardRequestBody(req: express.Request): void {
    if (!req.destroyed && !req.readableEnded) req.resume();
}

function sendMcpHttpFailure(res: express.Response, failure: McpHttpFailure): void {
    noStore(res).status(failure.status).json({
        error: failure.error,
        error_description: failure.description,
        ...failure.details,
    });
}

function bodyParserFailure(error: unknown): McpHttpFailure | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const candidate = error as { status?: unknown; statusCode?: unknown; type?: unknown };
    const type = typeof candidate.type === 'string' ? candidate.type : undefined;
    const status = typeof candidate.status === 'number'
        ? candidate.status
        : typeof candidate.statusCode === 'number'
            ? candidate.statusCode
            : undefined;

    switch (type) {
        case 'entity.too.large':
            return {
                status: 413,
                error: 'request_too_large',
                description: `MCP JSON request bodies are limited to ${MCP_JSON_BODY_LIMIT_BYTES} bytes.`,
                details: { max_bytes: MCP_JSON_BODY_LIMIT_BYTES },
            };
        case 'entity.parse.failed':
            return {
                status: 400,
                error: 'invalid_json',
                description: 'MCP request body must contain valid JSON.',
            };
        case 'charset.unsupported':
            return {
                status: 415,
                error: 'unsupported_charset',
                description: 'MCP JSON request bodies must use UTF-8.',
            };
        case 'encoding.unsupported':
            return {
                status: 415,
                error: 'unsupported_content_encoding',
                description: 'MCP request Content-Encoding is not supported.',
            };
        case 'request.aborted':
        case 'request.size.invalid':
            return {
                status: 400,
                error: 'incomplete_request',
                description: 'MCP request body was incomplete.',
            };
        case 'entity.verify.failed':
            return {
                status: 400,
                error: 'invalid_request_body',
                description: 'MCP request body could not be accepted.',
            };
        case 'stream.encoding.set':
        case 'stream.not.readable':
            return {
                status: 500,
                error: 'request_body_unavailable',
                description: 'MCP request body could not be read.',
            };
        default:
            if (status !== undefined && status >= 400 && status < 500 && type !== undefined) {
                return {
                    status,
                    error: 'invalid_request_body',
                    description: 'MCP request body could not be accepted.',
                };
            }
            return undefined;
    }
}

function releaseBudgetOnCompletion(
    req: express.Request,
    res: express.Response,
    releaseBudget: () => void,
): void {
    let completed = false;
    const release = () => {
        if (completed) return;
        completed = true;
        req.off('aborted', release);
        req.off('error', release);
        res.off('finish', release);
        res.off('close', release);
        releaseBudget();
    };
    req.once('aborted', release);
    req.once('error', release);
    res.once('finish', release);
    res.once('close', release);
}

export interface RemoteHttpHandlers {
    handleMcpRequest: (req: express.Request, res: express.Response) => Promise<void>;
    completeGmailOAuthCallback: (params: {
        code?: string;
        state?: string;
    }) => Promise<{ accountEmail: string; scopes: string[] }>;
}

export function createRemoteHttpApp(
    config: RemoteServerConfig,
    store: OAuthStateStore,
    handlers: RemoteHttpHandlers,
): express.Application {
    const app = express();
    // The limit applies to encoded JSON. Base64 expands binary data by about 4/3,
    // so a request can carry at most roughly 24 MiB of raw binary plus JSON overhead.
    const mcpJsonParser = express.json({
        limit: MCP_JSON_BODY_LIMIT_BYTES,
        type: 'application/json',
    });
    const mcpInFlightBudget = new McpInFlightBudget();
    app.disable('x-powered-by');
    app.enable('strict routing');
    app.set('trust proxy', 'loopback');

    app.get('/healthz', (_req, res) => {
        res.json({ status: 'ok' });
    });
    app.get('/readyz', (_req, res) => {
        try {
            if (!store.isReady()) throw new Error('State database check failed.');
            res.json({ status: 'ready' });
        } catch {
            res.status(503).json({ status: 'not_ready' });
        }
    });

    app.get(config.protectedResourceMetadataPath, (_req, res) => {
        res.json(protectedResourceMetadata(config));
    });
    app.get(config.authorizationServerMetadataPath, (_req, res) => {
        res.json(oauthAuthorizationServerMetadata(config));
    });

    for (const legacyPath of [`${config.basePath}/sse`, `${config.basePath}/messages`]) {
        app.all(legacyPath, (_req, res) => {
            noStore(res).status(410).json({
                error: 'legacy_transport_removed',
                error_description: `Legacy MCP SSE transport was removed in v2; reconnect using Streamable HTTP at ${config.resourceUrl}.`,
            });
        });
    }

    app.post(config.registerPath, express.json({
        limit: '16kb',
        type: ['application/json', 'application/*+json'],
    }), (req, res) => {
        const rawRedirectUris: unknown[] = Array.isArray(req.body?.redirect_uris)
            ? req.body.redirect_uris
            : [];
        const redirectUris = rawRedirectUris.filter((uri): uri is string => typeof uri === 'string');
        const uniqueRedirectUris: string[] = [...new Set(redirectUris)];
        if (uniqueRedirectUris.length === 0 || uniqueRedirectUris.length > 4) {
            sendOAuthError(res, 400, 'invalid_client_metadata', 'redirect_uris must contain between one and four URIs.');
            return;
        }
        if (uniqueRedirectUris.some(uri => uri.length > 2048)) {
            sendOAuthError(res, 400, 'invalid_client_metadata', 'redirect_uris entries must not exceed 2048 characters.');
            return;
        }
        if (uniqueRedirectUris.some(uri => !config.callbackAllowlist.has(uri))) {
            sendOAuthError(res, 400, 'invalid_client_metadata', 'One or more redirect_uris are not allowed.');
            return;
        }

        const clientName = typeof req.body?.client_name === 'string'
            ? req.body.client_name.trim()
            : undefined;
        if (clientName && clientName.length > 128) {
            sendOAuthError(res, 400, 'invalid_client_metadata', 'client_name must not exceed 128 characters.');
            return;
        }
        let client;
        try {
            client = store.registerClient(uniqueRedirectUris, clientName, Date.now(), req.ip);
        } catch (error) {
            if (error instanceof OAuthClientLimitError) {
                sendOAuthError(res, 429, 'temporarily_unavailable', error.message);
                return;
            }
            throw error;
        }
        noStore(res).status(201).json({
            client_id: client.clientId,
            client_id_issued_at: Math.floor(client.createdAt / 1000),
            redirect_uris: client.redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        });
    });

    app.get(config.authorizePath, (req, res) => {
        const params = readAuthorizeParams(req.query as Record<string, unknown>, config);
        const validationError = validateAuthorizeParams(params, config, store);
        if (validationError) {
            res.status(400).send(validationError);
            return;
        }
        noStore(res).type('html').send(renderAuthorizeForm(config.authorizePath, params));
    });

    app.post(config.authorizePath, express.urlencoded({ extended: false }), (req, res) => {
        const params = readAuthorizeParams(req.body as Record<string, unknown>, config);
        const validationError = validateAuthorizeParams(params, config, store);
        if (validationError) {
            res.status(400).send(validationError);
            return;
        }

        const submittedKey = typeof req.body?.api_key === 'string' ? req.body.api_key : '';
        if (!submittedKey || !timingSafeStringEquals(submittedKey, config.apiKey)) {
            noStore(res).status(401).type('html').send(
                renderAuthorizeForm(config.authorizePath, params, 'Invalid API key.'),
            );
            return;
        }

        const code = store.createAuthorizationCode({
            clientId: params.client_id,
            redirectUri: params.redirect_uri,
            codeChallenge: params.code_challenge,
            scope: params.scope,
            audience: params.resource,
            expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        });
        const redirectUrl = new URL(params.redirect_uri);
        redirectUrl.searchParams.set('code', code);
        if (params.state) redirectUrl.searchParams.set('state', params.state);
        res.redirect(302, redirectUrl.toString());
    });

    app.post(
        config.tokenPath,
        express.urlencoded({ extended: false }),
        express.json({ type: ['application/json', 'application/*+json'] }),
        (req, res) => {
            const grantType = req.body?.grant_type;
            const requestedResource = typeof req.body?.resource === 'string'
                ? req.body.resource
                : config.resourceUrl;
            if (requestedResource !== config.resourceUrl) {
                sendOAuthError(res, 400, 'invalid_target', 'The requested resource does not match this MCP server.');
                return;
            }

            if (grantType === 'authorization_code') {
                const tokens = store.exchangeAuthorizationCode({
                    code: typeof req.body?.code === 'string' ? req.body.code : '',
                    clientId: typeof req.body?.client_id === 'string' ? req.body.client_id : '',
                    redirectUri: typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '',
                    codeVerifier: typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '',
                    audience: requestedResource,
                });
                if (!tokens) {
                    sendOAuthError(res, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used.');
                    return;
                }
                noStore(res).json(tokens);
                return;
            }

            if (grantType === 'refresh_token') {
                const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
                if (!clientId) {
                    sendOAuthError(res, 400, 'invalid_grant', 'client_id is required for refresh token exchange.');
                    return;
                }
                const tokens = store.rotateRefreshToken({
                    refreshToken: typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '',
                    clientId,
                    audience: requestedResource,
                });
                if (!tokens) {
                    sendOAuthError(res, 400, 'invalid_grant', 'Refresh token is invalid, expired, or already used.');
                    return;
                }
                noStore(res).json(tokens);
                return;
            }

            sendOAuthError(
                res,
                400,
                'unsupported_grant_type',
                'Only authorization_code and refresh_token grants are supported.',
            );
        },
    );

    app.post(
        config.revokePath,
        express.urlencoded({ extended: false, limit: '16kb' }),
        express.json({ limit: '16kb', type: ['application/json', 'application/*+json'] }),
        (req, res) => {
            const token = typeof req.body?.token === 'string' ? req.body.token : '';
            const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
            if (!token || !clientId || !store.getClient(clientId)) {
                sendOAuthError(res, 400, 'invalid_request', 'token and a valid client_id are required.');
                return;
            }
            store.revokeToken(token, clientId);
            noStore(res).status(200).send();
        },
    );

    app.get(config.googleCallbackPath, async (req, res) => {
        const googleError = queryValue(req.query.error);
        if (googleError) {
            noStore(res).status(400).type('html').send(
                renderGmailOAuthResultPage(false, `Google OAuth failed: ${googleError}`),
            );
            return;
        }
        try {
            const result = await handlers.completeGmailOAuthCallback({
                code: queryValue(req.query.code),
                state: queryValue(req.query.state),
            });
            noStore(res).type('html').send(renderGmailOAuthResultPage(
                true,
                `Gmail authentication successful for ${result.accountEmail}; you can return to your MCP client.`,
            ));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Gmail authentication failed.';
            const status = error instanceof GmailOAuthError ? error.statusCode : 500;
            noStore(res).status(status).type('html').send(renderGmailOAuthResultPage(false, message));
        }
    });

    app.all(
        config.mcpPath,
        (req, res, next) => {
            const bearer = extractBearerToken(req);
            if (!bearer || !store.verifyAccessToken(bearer, config.resourceUrl)) {
                sendRemoteAuthChallenge(config, res);
                return;
            }
            next();
        },
        (req, res, next) => {
            const contentLength = readContentLength(req);
            const hasBody = requestHasBody(req, contentLength);
            if (hasBody && req.is('application/json') !== 'application/json') {
                discardRequestBody(req);
                sendMcpHttpFailure(res, {
                    status: 415,
                    error: 'unsupported_media_type',
                    description: 'MCP requests with a body must use Content-Type: application/json.',
                });
                return;
            }
            if (contentLength.kind === 'invalid') {
                discardRequestBody(req);
                sendMcpHttpFailure(res, {
                    status: 400,
                    error: 'invalid_content_length',
                    description: 'MCP request Content-Length is invalid.',
                });
                return;
            }
            if (contentLength.kind === 'oversized') {
                discardRequestBody(req);
                sendMcpHttpFailure(res, {
                    status: 413,
                    error: 'request_too_large',
                    description: `MCP JSON request bodies are limited to ${MCP_JSON_BODY_LIMIT_BYTES} bytes.`,
                    details: { max_bytes: MCP_JSON_BODY_LIMIT_BYTES },
                });
                return;
            }

            const releaseBudget = mcpInFlightBudget.tryAcquire(bodyReservationBytes(req, contentLength));
            if (!releaseBudget) {
                discardRequestBody(req);
                res.set('Retry-After', String(MCP_BUSY_RETRY_AFTER_SECONDS));
                sendMcpHttpFailure(res, {
                    status: 503,
                    error: 'server_busy',
                    description: 'MCP request capacity is temporarily exhausted; retry later.',
                });
                return;
            }
            releaseBudgetOnCompletion(req, res, releaseBudget);
            next();
        },
        (req, res, next) => {
            mcpJsonParser(req, res, error => {
                const failure = bodyParserFailure(error);
                if (failure) {
                    discardRequestBody(req);
                    if (!res.destroyed && !res.headersSent) sendMcpHttpFailure(res, failure);
                    return;
                }
                next(error);
            });
        },
        async (req, res) => {
            await handlers.handleMcpRequest(req, res);
        },
    );

    return app;
}
