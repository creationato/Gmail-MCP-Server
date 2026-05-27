#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import {createEmailMessage, createEmailWithNodemailer} from "./utl.js";
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel, GmailLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates, GmailFilterCriteria, GmailFilterAction } from "./filter-manager.js";
import { parseEmailAddresses, filterOutEmail, addRePrefix, buildReferencesHeader, buildReplyAllRecipients } from "./reply-all-helpers.js";
import { DEFAULT_SCOPES, parseScopes, validateScopes, hasScope, getAvailableScopeNames } from "./scopes.js";
import { toolDefinitions, toMcpTools, getToolByName, SendEmailSchema, ReadEmailSchema, SearchEmailsSchema, ModifyEmailSchema, DeleteEmailSchema, BatchModifyEmailsSchema, ReportPhishingSchema, BatchReportPhishingSchema, BatchDeleteEmailsSchema, CreateLabelSchema, UpdateLabelSchema, DeleteLabelSchema, GetOrCreateLabelSchema, CreateFilterSchema, GetFilterSchema, DeleteFilterSchema, CreateFilterFromTemplateSchema, DownloadAttachmentSchema, ReplyAllSchema, GetThreadSchema, ListInboxThreadsSchema, GetInboxWithThreadsSchema, DownloadEmailSchema, ModifyThreadSchema, SendDraftSchema, DeleteDraftSchema, UpdateDraftSchema, ScheduleEmailSchema, ListScheduledEmailsSchema, CancelScheduledEmailSchema, AuthenticateAccountSchema } from "./tools.js";
import { gmailMessageToJson, emailToTxt, emailToHtml, EmailAttachment } from "./email-export.js";
import {
    CREDENTIALS_PATH,
    CONFIG_DIR,
    GmailOAuthError,
    LOCAL_GMAIL_CALLBACK_URL,
    OAUTH_PATH,
    authenticate,
    completeGmailOAuthCallback,
    createGmailOAuthClient,
    loadOAuthKeys,
    startLocalGmailOAuthFlow,
    startRemoteGmailOAuthFlow,
} from "./gmail-oauth.js";
import {
    listAuthenticatedAccounts,
    isAccountAuthenticated,
    getAccountCredentialsPath,
    loadQueue,
    saveQueue,
    ensureDirectories,
    ScheduledEmail
} from "./db.js";


// Dynamically resolve account credentials
async function getAccountClient(accountEmail?: string): Promise<{ gmail: any; authorizedScopes: string[]; oauthClient: OAuth2Client }> {
    ensureDirectories();

    const keys = loadOAuthKeys();

    let credPath = CREDENTIALS_PATH;
    let activeEmail = accountEmail;

    if (accountEmail) {
        credPath = getAccountCredentialsPath(accountEmail);
        if (!fs.existsSync(credPath)) {
            throw new Error(`Account "${accountEmail}" is not authenticated. Please run the auth command: node dist/index.js auth --account=${accountEmail}`);
        }
    } else {
        const accounts = listAuthenticatedAccounts();
        if (accounts.length > 0) {
            activeEmail = accounts[0];
            credPath = getAccountCredentialsPath(activeEmail);
        } else if (!fs.existsSync(CREDENTIALS_PATH)) {
            throw new Error('No authenticated accounts found. Please authenticate an account first.');
        }
    }

    const oauthClient = createGmailOAuthClient(LOCAL_GMAIL_CALLBACK_URL, keys);

    let scopes = DEFAULT_SCOPES;
    if (fs.existsSync(credPath)) {
        const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const tokens = credentials.tokens || credentials;
        oauthClient.setCredentials(tokens);
        if (credentials.scopes) {
            scopes = credentials.scopes;
        }
    } else {
        throw new Error(`Credentials file not found at ${credPath}`);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauthClient });
    return { gmail, authorizedScopes: scopes, oauthClient };
}

function parseScheduledTime(timeStr: string): string {
    const relativeMatch = timeStr.match(/^\+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i);
    if (relativeMatch) {
        const amount = parseInt(relativeMatch[1], 10);
        const unit = relativeMatch[2].toLowerCase();
        const date = new Date();
        if (unit.startsWith('minute')) {
            date.setMinutes(date.getMinutes() + amount);
        } else if (unit.startsWith('hour')) {
            date.setHours(date.getHours() + amount);
        } else if (unit.startsWith('day')) {
            date.setDate(date.getDate() + amount);
        }
        return date.toISOString();
    }
    
    const parsed = Date.parse(timeStr);
    if (isNaN(parsed)) {
        throw new Error(`Invalid scheduledTime format: "${timeStr}". Must be an ISO timestamp or relative duration (e.g., '+5 minutes').`);
    }
    return new Date(parsed).toISOString();
}

async function startSchedulerDaemon() {
    console.log('Starting Gmail MCP Scheduler Daemon...');
    ensureDirectories();
    
    while (true) {
        try {
            const queue = loadQueue();
            const now = new Date();
            const pending = queue.filter(item => item.status === 'pending' && new Date(item.scheduledTime) <= now);
            
            if (pending.length > 0) {
                console.log(`Found ${pending.length} pending scheduled emails to send.`);
                
                for (const email of pending) {
                    const jitter = Math.floor(Math.random() * 40000) + 5000;
                    console.log(`Scheduling send for email ID ${email.id} from ${email.account} with random organic jitter of ${Math.round(jitter/1000)}s...`);
                    await new Promise(resolve => setTimeout(resolve, jitter));
                    
                    try {
                        const { gmail } = await getAccountClient(email.account);
                        console.log(`Sending email ${email.id} using account ${email.account}...`);
                        
                        let rawMessage;
                        if (email.attachments && email.attachments.length > 0) {
                            rawMessage = await createEmailWithNodemailer({
                                to: email.to,
                                subject: email.subject,
                                body: email.body,
                                htmlBody: email.htmlBody,
                                cc: email.cc,
                                bcc: email.bcc,
                                threadId: email.threadId,
                                inReplyTo: email.inReplyTo,
                                attachments: email.attachments
                            });
                        } else {
                            rawMessage = createEmailMessage({
                                to: email.to,
                                subject: email.subject,
                                body: email.body,
                                htmlBody: email.htmlBody,
                                cc: email.cc,
                                bcc: email.bcc,
                                threadId: email.threadId,
                                inReplyTo: email.inReplyTo
                            });
                        }
                        
                        const encodedMessage = Buffer.from(rawMessage).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');
                            
                        const result = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: encodedMessage,
                                ...(email.threadId && { threadId: email.threadId })
                            }
                        });
                        
                        email.status = 'sent';
                        email.actualSentTime = new Date().toISOString();
                        email.attempts++;
                        console.log(`Successfully sent email ID ${email.id}! Gmail Message ID: ${result.data.id}`);
                    } catch (sendError) {
                        email.attempts++;
                        console.error(`Failed to send email ID ${email.id} (Attempt ${email.attempts}):`, (sendError as any).message);
                        
                        if (email.attempts >= 3) {
                            email.status = 'failed';
                            email.errorMessage = (sendError as any).message;
                        }
                    }
                    
                    saveQueue(queue);
                }
            }
        } catch (loopError) {
            console.error('Error in scheduler loop iteration:', (loopError as any).message);
        }
        
        const checkSleep = Math.floor(50000 + Math.random() * 20000);
        console.log(`Scheduler sleeping for ${Math.round(checkSleep/1000)} seconds before next queue check...`);
        await new Promise(resolve => setTimeout(resolve, checkSleep));
    }
}

// Type definitions for Gmail API responses
interface GmailMessagePart {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers?: Array<{
        name: string;
        value: string;
    }>;
    body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
    };
    parts?: GmailMessagePart[];
}

interface EmailContent {
    text: string;
    html: string;
}

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let authorizedScopes: string[] = DEFAULT_SCOPES;

const REMOTE_MCP_SCOPE = "gmail";
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface RegisteredOAuthClient {
    clientId: string;
    redirectUris: string[];
    clientName?: string;
    createdAt: number;
}

interface PendingAuthCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    expiresAt: number;
}

interface IssuedRemoteToken {
    token: string;
    scope: string;
    expiresAt: number;
}

interface IssuedRefreshToken {
    token: string;
    clientId: string;
    scope: string;
    expiresAt: number;
}

const registeredOAuthClients = new Map<string, RegisteredOAuthClient>();
const pendingAuthCodes = new Map<string, PendingAuthCode>();
const issuedAccessTokens = new Map<string, IssuedRemoteToken>();
const issuedRefreshTokens = new Map<string, IssuedRefreshToken>();

function getConfiguredRemoteApiKey(): string | undefined {
    const apiKey = process.env.GMAIL_MCP_API_KEY?.trim();
    return apiKey || undefined;
}

function getConfiguredPublicBaseUrl(): string | undefined {
    const raw = (process.env.GMAIL_MCP_PUBLIC_URL || process.env.MCP_PUBLIC_URL)?.trim();
    if (!raw) return undefined;

    try {
        const url = new URL(raw);
        url.search = "";
        url.hash = "";
        if (url.pathname.endsWith("/mcp")) {
            url.pathname = url.pathname.slice(0, -"/mcp".length) || "/";
        }
        return url.toString().replace(/\/$/, "");
    } catch {
        return raw.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
    }
}

function getRequestBaseUrl(req: express.Request): string {
    const configured = getConfiguredPublicBaseUrl();
    if (configured) return configured;

    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
    const proto = forwardedProto || req.protocol || "http";
    const host = forwardedHost || req.get("host") || "localhost";
    return `${proto}://${host}`;
}

function getProtectedResourceMetadataUrl(req: express.Request): string {
    return `${getRequestBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
}

function getMcpResourceUrl(req: express.Request): string {
    return `${getRequestBaseUrl(req)}/mcp`;
}

function oauthAuthorizationServerMetadata(req: express.Request) {
    const baseUrl = getRequestBaseUrl(req);
    return {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [REMOTE_MCP_SCOPE, "offline_access"],
    };
}

function protectedResourceMetadata(req: express.Request) {
    return {
        resource: getMcpResourceUrl(req),
        authorization_servers: [getRequestBaseUrl(req)],
        bearer_methods_supported: ["header"],
        scopes_supported: [REMOTE_MCP_SCOPE],
    };
}

function timingSafeStringEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(): string {
    return randomBytes(32).toString("base64url");
}

function base64Url(input: Buffer): string {
    return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkceS256(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest());
}

function cleanupRemoteAuthStores() {
    const now = Date.now();
    for (const [code, record] of pendingAuthCodes) {
        if (record.expiresAt <= now) pendingAuthCodes.delete(code);
    }
    for (const [token, record] of issuedAccessTokens) {
        if (record.expiresAt <= now) issuedAccessTokens.delete(token);
    }
    for (const [token, record] of issuedRefreshTokens) {
        if (record.expiresAt <= now) issuedRefreshTokens.delete(token);
    }
}

function extractBearerToken(req: express.Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.substring("Bearer ".length).trim();
    }
    return undefined;
}

function queryValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function isRemoteRequestAuthorized(req: express.Request): boolean {
    cleanupRemoteAuthStores();

    const apiKey = getConfiguredRemoteApiKey();
    const bearer = extractBearerToken(req);
    if (bearer) {
        if (apiKey && timingSafeStringEquals(bearer, apiKey)) {
            return true;
        }
        const issued = issuedAccessTokens.get(bearer);
        if (issued && issued.expiresAt > Date.now()) {
            return true;
        }
    }

    const queryApiKey = queryValue(req.query.api_key);
    return !!(apiKey && queryApiKey && timingSafeStringEquals(queryApiKey, apiKey));
}

function sendRemoteAuthChallenge(req: express.Request, res: express.Response): void {
    const header =
        `Bearer error="invalid_token", ` +
        `error_description="Authentication required", ` +
        `resource_metadata="${getProtectedResourceMetadataUrl(req)}", ` +
        `scope="${REMOTE_MCP_SCOPE}"`;

    res
        .status(401)
        .set("WWW-Authenticate", header)
        .json({
            error: "invalid_token",
            error_description: "Authentication required",
        });
}

function noStore(res: express.Response): express.Response {
    return res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => {
        switch (char) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#39;";
            default: return char;
        }
    });
}

function renderAuthorizeForm(params: Record<string, string>, error?: string): string {
    const hiddenInputs = Object.entries(params)
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join("\n");

    const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : "";

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
  <p class="hint">Enter the server API key to allow this Claude connector to use the Gmail MCP server.</p>
  ${errorMarkup}
  <form method="post" action="/authorize">
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
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #1f2937; }
    h1 { color: ${color}; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function issueRemoteTokens(clientId: string, scope: string) {
    cleanupRemoteAuthStores();

    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = Date.now();

    issuedAccessTokens.set(accessToken, {
        token: accessToken,
        scope,
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    issuedRefreshTokens.set(refreshToken, {
        token: refreshToken,
        clientId,
        scope,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });

    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope,
    };
}

function sendOAuthError(res: express.Response, status: number, error: string, description: string): void {
    noStore(res).status(status).json({
        error,
        error_description: description,
    });
}

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    // Initialize containers for different content types
    let textContent = '';
    let htmlContent = '';

    // If the part has a body with data, process it based on MIME type
    if (messagePart.body && messagePart.body.data) {
        const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');

        // Store content based on its MIME type
        if (messagePart.mimeType === 'text/plain') {
            textContent = content;
        } else if (messagePart.mimeType === 'text/html') {
            htmlContent = content;
        }
    }

    // If the part has nested parts, recursively process them
    if (messagePart.parts && messagePart.parts.length > 0) {
        for (const part of messagePart.parts) {
            const { text, html } = extractEmailContent(part);
            if (text) textContent += text;
            if (html) htmlContent += html;
        }
    }

    // Return both plain text and HTML content
    return { text: textContent, html: htmlContent };
}

/**
 * Extract common headers from Gmail message payload
 */
function extractHeaders(payload: any): { subject: string; from: string; to: string; cc: string; bcc: string; date: string; rfcMessageId: string } {
    const headers = payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
    return {
        subject: getHeader("subject"),
        from: getHeader("from"),
        to: getHeader("to"),
        cc: getHeader("cc"),
        bcc: getHeader("bcc"),
        date: getHeader("date"),
        rfcMessageId: getHeader("message-id"),
    };
}

/**
 * Extract attachments from Gmail message payload
 */
function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    function processAttachmentParts(part: GmailMessagePart) {
        if (part.body && part.body.attachmentId) {
            attachments.push({
                id: part.body.attachmentId,
                filename: part.filename || `attachment-${part.body.attachmentId}`,
                mimeType: part.mimeType || "application/octet-stream",
                size: part.body.size || 0,
            });
        }
        if (part.parts) {
            part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
        }
    }

    processAttachmentParts(payload);
    return attachments;
}

async function loadCredentials(callbackUrl = LOCAL_GMAIL_CALLBACK_URL) {
    try {
        // Create config directory if it doesn't exist
        if (!process.env.GMAIL_OAUTH_PATH && !process.env.GMAIL_CREDENTIALS_PATH && !fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');

        if (fs.existsSync(localOAuthPath)) {
            // If found in current directory, copy to config directory
            fs.copyFileSync(localOAuthPath, OAUTH_PATH);
            console.log('OAuth keys found in current directory, copied to global config.');
        }

        const keys = loadOAuthKeys();
        oauth2Client = createGmailOAuthClient(callbackUrl, keys);

        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

            // Credentials file structure (v1.2.0+):
            //   { "tokens": { access_token, refresh_token, ... }, "scopes": ["gmail.readonly", ...] }
            //
            // Legacy structure (pre-v1.2.0):
            //   { access_token, refresh_token, ... }
            //
            // We support both formats for backwards compatibility. Users with legacy
            // credentials will get DEFAULT_SCOPES (full access) until they re-authenticate.
            const tokens = credentials.tokens || credentials;
            oauth2Client.setCredentials(tokens);

            if (credentials.scopes) {
                authorizedScopes = credentials.scopes;
            }
        }
    } catch (error: any) {
        console.error('Error loading credentials:', error.message || error);
        process.exit(1);
    }
}

function getCliCallbackUrl(): string {
    const callbackArg = process.argv.find(arg =>
        arg.startsWith('http://') || arg.startsWith('https://')
    );
    return callbackArg || LOCAL_GMAIL_CALLBACK_URL;
}

// Main function
async function main() {
    ensureDirectories();
    
    // CLI Scheduler Trigger
    if (process.argv[2] === 'scheduler') {
        await startSchedulerDaemon();
        return;
    }

    if (process.argv[2] === 'auth') {
        const scopesArg = process.argv.find(arg => arg.startsWith('--scopes='));
        const accountArg = process.argv.find(arg => arg.startsWith('--account='));
        let accountEmail;
        if (accountArg) {
            accountEmail = accountArg.slice('--account='.length);
        }
        
        let scopes = DEFAULT_SCOPES;

        if (scopesArg) {
            const scopesValue = scopesArg.slice('--scopes='.length);
            scopes = parseScopes(scopesValue);
            const validation = validateScopes(scopes);

            if (!validation.valid) {
                console.error('Error: Invalid scope(s):', validation.invalid.join(', '));
                process.exit(1);
            }
        }
        
        const callbackUrl = getCliCallbackUrl();
        await loadCredentials(callbackUrl);
        await authenticate(scopes, accountEmail, callbackUrl);
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    interface McpServerOptions {
        gmailOAuthPublicBaseUrl?: string;
    }

    // Function to create a server instance and register all handlers
    function createMcpServer(options: McpServerOptions = {}): Server {
        const server = new Server(
            {
                name: "gmail",
                version: "1.0.0",
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );

    // Tool handlers
    // Filter available tools based on authorized scopes
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        let scopes = DEFAULT_SCOPES;
        try {
            const clientInfo = await getAccountClient();
            scopes = clientInfo.authorizedScopes;
        } catch (e) {
            // Keep default scopes if no primary credentials found
        }
        const availableTools = toolDefinitions.filter(tool =>
            hasScope(scopes, tool.scopes)
        );
        return { tools: toMcpTools(availableTools) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const validatedArgs = args as any;

        const toolDef = getToolByName(name);
        if (!toolDef) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Tool "${name}" is not found.`,
                }],
            };
        }

        if (name === "list_accounts") {
            const accounts = listAuthenticatedAccounts();
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ accounts }, null, 2),
                }],
            };
        }

        if (name === "authenticate_account") {
            try {
                const authArgs = AuthenticateAccountSchema.parse(args);
                const scopes = authArgs.scopes || DEFAULT_SCOPES;

                if (options.gmailOAuthPublicBaseUrl) {
                    const flow = startRemoteGmailOAuthFlow({
                        accountEmail: authArgs.email,
                        scopes,
                        publicBaseUrl: options.gmailOAuthPublicBaseUrl,
                    });

                    return {
                        content: [{
                            type: "text",
                            text: `Google OAuth registration started for account: "${flow.accountEmail}".\n\nOpen this URL to authorize Gmail access:\n\n${flow.authUrl}\n\nAfter approval, Google will return to ${flow.redirectUri} and this server will save the credentials.`,
                        }],
                    };
                }

                const authUrl = startLocalGmailOAuthFlow(scopes, authArgs.email);
                return {
                    content: [{
                        type: "text",
                        text: `Google OAuth registration started for account: "${authArgs.email}".\n\nA browser window has been opened on this machine when possible. If it did not open, visit this URL to authorize:\n\n${authUrl}\n\nOnce authorized, the credentials will be saved locally.`,
                    }],
                };
            } catch (error: any) {
                return {
                    content: [{
                        type: "text",
                        text: `Error starting Gmail OAuth: ${error.message}`,
                    }],
                };
            }
        }

        // Dynamically resolve client for requested account
        let gmailClientInfo;
        try {
            gmailClientInfo = await getAccountClient(validatedArgs?.account);
        } catch (error) {
            return {
                content: [{
                    type: "text",
                    text: `Error resolving Gmail client: ${(error as any).message}`,
                }],
            };
        }

        const { gmail, authorizedScopes } = gmailClientInfo;

        if (!hasScope(authorizedScopes, toolDef.scopes)) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Tool "${name}" is not authorized for the scopes available on account "${validatedArgs?.account || 'primary'}". Authorized scopes: ${authorizedScopes.join(', ')}`,
                }],
            };
        }

        async function handleEmailAction(action: "send" | "draft", validatedArgs: any) {
            let message: string;

            try {
                // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
                if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
                    try {
                        const threadResponse = await gmail.users.threads.get({
                            userId: 'me',
                            id: validatedArgs.threadId,
                            format: 'metadata',
                            metadataHeaders: ['Message-ID'],
                        });

                        const threadMessages = threadResponse.data.messages || [];
                        if (threadMessages.length > 0) {
                            // Collect all Message-ID values for the References chain
                            const allMessageIds: string[] = [];
                            for (const msg of threadMessages) {
                                const msgHeaders = msg.payload?.headers || [];
                                const messageIdHeader = msgHeaders.find(
                                    (h: any) => h.name?.toLowerCase() === 'message-id'
                                );
                                if (messageIdHeader?.value) {
                                    allMessageIds.push(messageIdHeader.value);
                                }
                            }

                            // Last message's Message-ID becomes In-Reply-To
                            const lastMessage = threadMessages[threadMessages.length - 1];
                            const lastHeaders = lastMessage.payload?.headers || [];
                            const lastMessageId = lastHeaders.find(
                                (h: any) => h.name?.toLowerCase() === 'message-id'
                            )?.value;

                            if (lastMessageId) {
                                validatedArgs.inReplyTo = lastMessageId;
                            }
                            if (allMessageIds.length > 0) {
                                validatedArgs.references = allMessageIds.join(' ');
                            }
                        }
                    } catch (threadError: any) {
                        console.warn(`Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${threadError.message}`);
                        // Continue without threading headers - degraded but not broken
                    }
                }

                // Check if we have attachments
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    // Use Nodemailer to create properly formatted RFC822 message
                    message = await createEmailWithNodemailer(validatedArgs);
                    
                    if (action === "send") {
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');

                        const result = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: encodedMessage,
                                ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                            }
                        });
                        
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${result.data.id}`,
                                },
                            ],
                        };
                    } else {
                        // For drafts with attachments, use the raw message
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');
                        
                        const messageRequest = {
                            raw: encodedMessage,
                            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                        };
                        
                        const response = await gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                            },
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                } else {
                    // For emails without attachments, use the existing simple method
                    message = createEmailMessage(validatedArgs);
                    
                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

                    // Define the type for messageRequest
                    interface GmailMessageRequest {
                        raw: string;
                        threadId?: string;
                    }

                    const messageRequest: GmailMessageRequest = {
                        raw: encodedMessage,
                    };

                    // Add threadId if specified
                    if (validatedArgs.threadId) {
                        messageRequest.threadId = validatedArgs.threadId;
                    }

                    if (action === "send") {
                        const response = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: messageRequest,
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    } else {
                        const response = await gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                        },
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                }
            } catch (error: any) {
                // Log attachment-related errors for debugging
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    console.error(`Failed to send email with ${validatedArgs.attachments.length} attachments:`, error.message);
                }
                throw error;
            }
        }

        // Helper function to process operations in batches
        async function processBatches<T, U>(
            items: T[],
            batchSize: number,
            processFn: (batch: T[]) => Promise<U[]>
        ): Promise<{ successes: U[], failures: { item: T, error: Error }[] }> {
            const successes: U[] = [];
            const failures: { item: T, error: Error }[] = [];
            
            // Process in batches
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                try {
                    const results = await processFn(batch);
                    successes.push(...results);
                } catch (error) {
                    // If batch fails, try individual items
                    for (const item of batch) {
                        try {
                            const result = await processFn([item]);
                            successes.push(...result);
                        } catch (itemError) {
                            failures.push({ item, error: itemError as Error });
                        }
                    }
                }
            }
            
            return { successes, failures };
        }

        try {
            switch (name) {
                // --- NEW SCHEDULING TOOLS ---
                case "schedule_email": {
                    const scheduleArgs = ScheduleEmailSchema.parse(args);
                    const targetTime = parseScheduledTime(scheduleArgs.scheduledTime);
                    
                    let account = scheduleArgs.account;
                    if (!account) {
                        const accounts = listAuthenticatedAccounts();
                        account = accounts[0] || "default";
                    }
                    
                    const id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
                    const newEmail: ScheduledEmail = {
                        id,
                        account,
                        to: scheduleArgs.to,
                        subject: scheduleArgs.subject,
                        body: scheduleArgs.body,
                        htmlBody: scheduleArgs.htmlBody,
                        cc: scheduleArgs.cc,
                        bcc: scheduleArgs.bcc,
                        threadId: scheduleArgs.threadId,
                        inReplyTo: scheduleArgs.inReplyTo,
                        attachments: scheduleArgs.attachments,
                        scheduledTime: targetTime,
                        status: 'pending',
                        attempts: 0
                    };
                    
                    const queue = loadQueue();
                    queue.push(newEmail);
                    saveQueue(queue);
                    
                    return {
                        content: [{
                            type: "text",
                            text: `Email successfully scheduled for account "${account}" to be sent at ${targetTime}. ID: ${id}`,
                        }],
                    };
                }

                case "list_scheduled_emails": {
                    const listArgs = ListScheduledEmailsSchema.parse(args);
                    const queue = loadQueue();
                    const filtered = listArgs.status 
                        ? queue.filter(e => e.status === listArgs.status)
                        : queue;
                        
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(filtered, null, 2),
                        }],
                    };
                }

                case "cancel_scheduled_email": {
                    const cancelArgs = CancelScheduledEmailSchema.parse(args);
                    const queue = loadQueue();
                    const initialLength = queue.length;
                    const filtered = queue.filter(e => e.id !== cancelArgs.id);
                    
                    if (filtered.length === initialLength) {
                        return {
                            content: [{
                                type: "text",
                                text: `Error: Scheduled email with ID "${cancelArgs.id}" not found.`,
                            }],
                        };
                    }
                    
                    saveQueue(filtered);
                    return {
                        content: [{
                            type: "text",
                            text: `Successfully cancelled scheduled email with ID "${cancelArgs.id}".`,
                        }],
                    };
                }
                case "send_email":
                case "draft_email": {
                    const validatedArgs = SendEmailSchema.parse(args);
                    const action = name === "send_email" ? "send" : "draft";
                    return await handleEmailAction(action, validatedArgs);
                }

                case "read_email": {
                    const validatedArgs = ReadEmailSchema.parse(args);
                    const response = await gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    });

                    const { subject, from, to, cc, bcc, date, rfcMessageId } = extractHeaders(response.data.payload);
                    const threadId = response.data.threadId || '';
                    const { text, html } = extractEmailContent(response.data.payload as GmailMessagePart || {});
                    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

                    // Use plain text content if available, otherwise use HTML content
                    const body = text || html || '';
                    const contentTypeNote = !text && html ?
                        '[Note: This email is HTML-formatted. Plain text version not available.]\n\n' : '';

                    // Add attachment info to output if any are present
                    const attachmentInfo = attachments.length > 0 ?
                        `\n\nAttachments (${attachments.length}):\n` +
                        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}${cc ? `\nCC: ${cc}` : ''}${bcc ? `\nBCC: ${bcc}` : ''}\nDate: ${date}\n\n${contentTypeNote}${body}${attachmentInfo}`,
                            },
                        ],
                    };
                }

                case "search_emails": {
                    const validatedArgs = SearchEmailsSchema.parse(args);
                    const response = await gmail.users.messages.list({
                        userId: 'me',
                        q: validatedArgs.query,
                        maxResults: validatedArgs.maxResults || 10,
                    });

                    const messages = response.data.messages || [];
                    const results = await Promise.all(
                        messages.map(async (msg: any) => {
                            const detail = await gmail.users.messages.get({
                                userId: 'me',
                                id: msg.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            });
                            const headers = detail.data.payload?.headers || [];
                            return {
                                id: msg.id,
                                subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
                                from: headers.find((h: any) => h.name === 'From')?.value || '',
                                date: headers.find((h: any) => h.name === 'Date')?.value || '',
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: results.map(r =>
                                    `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
                                ).join('\n'),
                            },
                        ],
                    };
                }

                case "download_email": {
                    const validatedArgs = DownloadEmailSchema.parse(args);
                    const { messageId, savePath, format } = validatedArgs;

                    try {
                        // Ensure save directory exists
                        if (!fs.existsSync(savePath)) {
                            fs.mkdirSync(savePath, { recursive: true });
                        }

                        // Always fetch full message for metadata (needed for attachments list)
                        const fullResponse = await gmail.users.messages.get({
                            userId: "me",
                            id: messageId,
                            format: "full",
                        });

                        const { subject, from, date } = extractHeaders(fullResponse.data.payload);
                        const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);

                        let content: string;

                        if (format === "eml") {
                            // For EML format, fetch raw RFC822 message
                            const rawResponse = await gmail.users.messages.get({
                                userId: "me",
                                id: messageId,
                                format: "raw",
                            });
                            content = Buffer.from(rawResponse.data.raw || "", "base64url").toString("utf-8");
                        } else {
                            // Extract email content for json/txt/html
                            const emailContent = extractEmailContent(fullResponse.data.payload as GmailMessagePart || {});

                            if (format === "json") {
                                const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
                                content = JSON.stringify(jsonData, null, 2);
                            } else if (format === "txt") {
                                content = emailToTxt(fullResponse.data, emailContent, attachments);
                            } else {
                                // html - just return the raw HTML content
                                content = emailToHtml(emailContent);
                            }
                        }

                        // Write file
                        const filename = `${messageId}.${format}`;
                        const fullPath = path.join(savePath, filename);
                        fs.writeFileSync(fullPath, content, "utf-8");
                        const stats = fs.statSync(fullPath);

                        // Return metadata with attachments
                        const result = {
                            status: "saved",
                            path: fullPath,
                            size: stats.size,
                            messageId,
                            subject,
                            from,
                            date,
                            attachments,
                        };

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result, null, 2),
                                },
                            ],
                        };
                    } catch (error: any) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to download email: ${error.message}`,
                                },
                            ],
                        };
                    }
                }

                // Updated implementation for the modify_email handler
                case "modify_email": {
                    const validatedArgs = ModifyEmailSchema.parse(args);
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.labelIds) {
                        requestBody.addLabelIds = validatedArgs.labelIds;
                    }
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }
                    
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: requestBody,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} labels updated successfully`,
                            },
                        ],
                    };
                }

                case "delete_email": {
                    const validatedArgs = DeleteEmailSchema.parse(args);
                    await gmail.users.messages.delete({
                        userId: 'me',
                        id: validatedArgs.messageId,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "send_draft": {
                    const validatedArgs = SendDraftSchema.parse(args);
                    const response = await gmail.users.drafts.send({
                        userId: 'me',
                        requestBody: { id: validatedArgs.draftId },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${validatedArgs.draftId} sent successfully as message ID: ${response.data.id}. The draft has been removed from Drafts.`,
                            },
                        ],
                    };
                }

                case "delete_draft": {
                    const validatedArgs = DeleteDraftSchema.parse(args);
                    await gmail.users.drafts.delete({
                        userId: 'me',
                        id: validatedArgs.draftId,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${validatedArgs.draftId} deleted successfully.`,
                            },
                        ],
                    };
                }

                case "update_draft": {
                    const validatedArgs = UpdateDraftSchema.parse(args);
                    const { draftId, ...messageArgs } = validatedArgs;

                    // Build the new MIME message using the same helpers as draft_email/send_email
                    let message: string;
                    if (messageArgs.attachments && messageArgs.attachments.length > 0) {
                        message = await createEmailWithNodemailer(messageArgs);
                    } else {
                        message = createEmailMessage(messageArgs);
                    }

                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

                    const messageRequest: any = { raw: encodedMessage };
                    if (messageArgs.threadId) messageRequest.threadId = messageArgs.threadId;

                    const response = await gmail.users.drafts.update({
                        userId: 'me',
                        id: draftId,
                        requestBody: { message: messageRequest },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${draftId} updated successfully (draft ID unchanged, content replaced).`,
                            },
                        ],
                    };
                }

                case "list_email_labels": {
                    const labelResults = await listLabels(gmail);
                    const systemLabels = labelResults.system;
                    const userLabels = labelResults.user;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                                    "System Labels:\n" +
                                    systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') +
                                    "\nUser Labels:\n" +
                                    userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n')
                            },
                        ],
                    };
                }

                case "batch_modify_emails": {
                    const validatedArgs = BatchModifyEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    const result = await gmail.users.messages.modify({
                                        userId: 'me',
                                        id: messageId,
                                        requestBody: requestBody,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch label modification complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "report_phishing": {
                    const validatedArgs = ReportPhishingSchema.parse(args);

                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: {
                            addLabelIds: ['SPAM'],
                        },
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} was updated with the SPAM label as the closest public Gmail API approximation of reporting phishing. Note: the Gmail API does not expose the full native Report phishing workflow.`,
                            },
                        ],
                    };
                }

                case "batch_report_phishing": {
                    const validatedArgs = BatchReportPhishingSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            await gmail.users.messages.batchModify({
                                userId: 'me',
                                requestBody: {
                                    ids: batch,
                                    addLabelIds: ['SPAM'],
                                },
                            });

                            return batch.map((messageId) => ({ messageId, success: true }));
                        }
                    );

                    const successCount = successes.length;
                    const failureCount = failures.length;

                    let resultText = `Batch phishing report complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    resultText += `Behavior: each message was updated with the SPAM label as the closest public Gmail API approximation of reporting phishing.\n`;
                    resultText += `Limitation: the Gmail API does not expose the full native Report phishing workflow.\n`;

                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "batch_delete_emails": {
                    const validatedArgs = BatchDeleteEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    await gmail.users.messages.delete({
                                        userId: 'me',
                                        id: messageId,
                                    });
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch delete operation complete.\n`;
                    resultText += `Successfully deleted: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to delete: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                // New label management handlers
                case "create_label": {
                    const validatedArgs = CreateLabelSchema.parse(args);
                    const result = await createLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "update_label": {
                    const validatedArgs = UpdateLabelSchema.parse(args);
                    
                    // Prepare request body with only the fields that were provided
                    const updates: any = {};
                    if (validatedArgs.name) updates.name = validatedArgs.name;
                    if (validatedArgs.messageListVisibility) updates.messageListVisibility = validatedArgs.messageListVisibility;
                    if (validatedArgs.labelListVisibility) updates.labelListVisibility = validatedArgs.labelListVisibility;
                    
                    const result = await updateLabel(gmail, validatedArgs.id, updates);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "delete_label": {
                    const validatedArgs = DeleteLabelSchema.parse(args);
                    const result = await deleteLabel(gmail, validatedArgs.id);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "get_or_create_label": {
                    const validatedArgs = GetOrCreateLabelSchema.parse(args);
                    const result = await getOrCreateLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    const action = result.type === 'user' && result.name === validatedArgs.name ? 'found existing' : 'created new';
                    
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }


                // Filter management handlers
                case "create_filter": {
                    const validatedArgs = CreateFilterSchema.parse(args);
                    const result = await createFilter(gmail, validatedArgs.criteria, validatedArgs.action);

                    // Format criteria for display
                    const criteriaText = Object.entries(validatedArgs.criteria)
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');

                    // Format actions for display
                    const actionText = Object.entries(validatedArgs.action)
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "list_filters": {
                    const result = await listFilters(gmail);
                    const filters = result.filters;

                    if (filters.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No filters found.",
                                },
                            ],
                        };
                    }

                    const filtersText = filters.map((filter: any) => {
                        const criteriaEntries = Object.entries(filter.criteria || {})
                            .filter(([_, value]) => value !== undefined)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        
                        const actionEntries = Object.entries(filter.action || {})
                            .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                            .join(', ');

                        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
                    }).join('\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${result.count} filters:\n\n${filtersText}`,
                            },
                        ],
                    };
                }

                case "get_filter": {
                    const validatedArgs = GetFilterSchema.parse(args);
                    const result = await getFilter(gmail, validatedArgs.filterId);

                    const criteriaText = Object.entries(result.criteria || {})
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');
                    
                    const actionText = Object.entries(result.action || {})
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "delete_filter": {
                    const validatedArgs = DeleteFilterSchema.parse(args);
                    const result = await deleteFilter(gmail, validatedArgs.filterId);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "create_filter_from_template": {
                    const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
                    const template = validatedArgs.template;
                    const params = validatedArgs.parameters;

                    let filterConfig;
                    
                    switch (template) {
                        case 'fromSender':
                            if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
                            filterConfig = filterTemplates.fromSender(params.senderEmail, params.labelIds, params.archive);
                            break;
                        case 'withSubject':
                            if (!params.subjectText) throw new Error("subjectText is required for withSubject template");
                            filterConfig = filterTemplates.withSubject(params.subjectText, params.labelIds, params.markAsRead);
                            break;
                        case 'withAttachments':
                            filterConfig = filterTemplates.withAttachments(params.labelIds);
                            break;
                        case 'largeEmails':
                            if (!params.sizeInBytes) throw new Error("sizeInBytes is required for largeEmails template");
                            filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                            break;
                        case 'containingText':
                            if (!params.searchText) throw new Error("searchText is required for containingText template");
                            filterConfig = filterTemplates.containingText(params.searchText, params.labelIds, params.markImportant);
                            break;
                        case 'mailingList':
                            if (!params.listIdentifier) throw new Error("listIdentifier is required for mailingList template");
                            filterConfig = filterTemplates.mailingList(params.listIdentifier, params.labelIds, params.archive);
                            break;
                        default:
                            throw new Error(`Unknown template: ${template}`);
                    }

                    const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                            },
                        ],
                    };
                }
                case "download_attachment": {
                    const validatedArgs = DownloadAttachmentSchema.parse(args);

                    try {
                        // Get the attachment data from Gmail API
                        const attachmentResponse = await gmail.users.messages.attachments.get({
                            userId: 'me',
                            messageId: validatedArgs.messageId,
                            id: validatedArgs.attachmentId,
                        });

                        if (!attachmentResponse.data.data) {
                            throw new Error('No attachment data received');
                        }

                        // Decode the base64 data
                        const data = attachmentResponse.data.data;
                        const buffer = Buffer.from(data, 'base64url');

                        // Determine save path and filename
                        const savePath = validatedArgs.savePath || process.cwd();
                        let filename = validatedArgs.filename;

                        if (!filename) {
                            // Get original filename from message if not provided
                            const messageResponse = await gmail.users.messages.get({
                                userId: 'me',
                                id: validatedArgs.messageId,
                                format: 'full',
                            });

                            // Find the attachment part to get original filename
                            const findAttachment = (part: any): string | null => {
                                if (part.body && part.body.attachmentId === validatedArgs.attachmentId) {
                                    return part.filename || `attachment-${validatedArgs.attachmentId}`;
                                }
                                if (part.parts) {
                                    for (const subpart of part.parts) {
                                        const found = findAttachment(subpart);
                                        if (found) return found;
                                    }
                                }
                                return null;
                            };

                            filename = findAttachment(messageResponse.data.payload) || `attachment-${validatedArgs.attachmentId}`;
                        }

                        // Sanitize filename to prevent path traversal
                        filename = path.basename(filename);

                        // Ensure save directory exists
                        if (!fs.existsSync(savePath)) {
                            fs.mkdirSync(savePath, { recursive: true });
                        }

                        // Resolve and validate final path stays within savePath
                        const resolvedSavePath = path.resolve(savePath);
                        const fullPath = path.resolve(resolvedSavePath, filename);
                        if (!fullPath.startsWith(resolvedSavePath + path.sep) && fullPath !== resolvedSavePath) {
                            throw new Error('Invalid filename: path traversal detected');
                        }
                        fs.writeFileSync(fullPath, buffer);

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
                                },
                            ],
                        };
                    } catch (error: any) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to download attachment: ${error.message}`,
                                },
                            ],
                        };
                    }
                }

                case "get_thread": {
                    const validatedArgs = GetThreadSchema.parse(args);
                    const threadResponse = await gmail.users.threads.get({
                        userId: 'me',
                        id: validatedArgs.threadId,
                        format: validatedArgs.format || 'full',
                    });

                    const threadMessages = threadResponse.data.messages || [];

                    // Process each message in the thread (already chronological from API)
                    const messagesOutput = threadMessages.map((msg: any) => {
                        const headers = msg.payload?.headers || [];
                        const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                        const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                        const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
                        const cc = headers.find((h: any) => h.name?.toLowerCase() === 'cc')?.value || '';
                        const bcc = headers.find((h: any) => h.name?.toLowerCase() === 'bcc')?.value || '';
                        const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';

                        // Extract body content
                        let body = '';
                        if (validatedArgs.format !== 'minimal') {
                            const { text, html } = extractEmailContent(msg.payload as GmailMessagePart || {});
                            body = text || html || '';
                        }

                        // Extract attachment metadata
                        const attachments: EmailAttachment[] = [];
                        const processAttachmentParts = (part: GmailMessagePart) => {
                            if (part.body && part.body.attachmentId) {
                                const filename = part.filename || `attachment-${part.body.attachmentId}`;
                                attachments.push({
                                    id: part.body.attachmentId,
                                    filename: filename,
                                    mimeType: part.mimeType || 'application/octet-stream',
                                    size: part.body.size || 0,
                                });
                            }
                            if (part.parts) {
                                part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
                            }
                        };
                        if (msg.payload) {
                            processAttachmentParts(msg.payload as GmailMessagePart);
                        }

                        return {
                            messageId: msg.id || '',
                            threadId: msg.threadId || '',
                            from,
                            to,
                            cc,
                            bcc,
                            subject,
                            date,
                            body,
                            labelIds: msg.labelIds || [],
                            attachments: attachments.map(a => ({
                                filename: a.filename,
                                mimeType: a.mimeType,
                                size: a.size,
                            })),
                        };
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    threadId: validatedArgs.threadId,
                                    messageCount: messagesOutput.length,
                                    messages: messagesOutput,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "list_inbox_threads": {
                    const validatedArgs = ListInboxThreadsSchema.parse(args);
                    const threadsResponse = await gmail.users.threads.list({
                        userId: 'me',
                        q: validatedArgs.query || 'in:inbox',
                        maxResults: validatedArgs.maxResults || 50,
                    });

                    const threads = threadsResponse.data.threads || [];

                    // Fetch metadata for each thread to get message count and latest message info
                    const threadDetails = await Promise.all(
                        threads.map(async (thread: any) => {
                            const detail = await gmail.users.threads.get({
                                userId: 'me',
                                id: thread.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            });

                            const messages = detail.data.messages || [];
                            const latestMessage = messages[messages.length - 1];
                            const latestHeaders = latestMessage?.payload?.headers || [];

                            return {
                                threadId: thread.id || '',
                                snippet: thread.snippet || '',
                                historyId: thread.historyId || '',
                                messageCount: messages.length,
                                latestMessage: {
                                    from: latestHeaders.find((h: any) => h.name === 'From')?.value || '',
                                    subject: latestHeaders.find((h: any) => h.name === 'Subject')?.value || '',
                                    date: latestHeaders.find((h: any) => h.name === 'Date')?.value || '',
                                },
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    resultCount: threadDetails.length,
                                    threads: threadDetails,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "get_inbox_with_threads": {
                    const validatedArgs = GetInboxWithThreadsSchema.parse(args);
                    const threadsResponse = await gmail.users.threads.list({
                        userId: 'me',
                        q: validatedArgs.query || 'in:inbox',
                        maxResults: validatedArgs.maxResults || 50,
                    });

                    const threads = threadsResponse.data.threads || [];

                    if (!validatedArgs.expandThreads) {
                        // Return basic thread list without expansion (same as list_inbox_threads)
                        const threadSummaries = await Promise.all(
                            threads.map(async (thread: any) => {
                                const detail = await gmail.users.threads.get({
                                    userId: 'me',
                                    id: thread.id!,
                                    format: 'metadata',
                                    metadataHeaders: ['Subject', 'From', 'Date'],
                                });

                                const messages = detail.data.messages || [];
                                const latestMessage = messages[messages.length - 1];
                                const latestHeaders = latestMessage?.payload?.headers || [];

                                return {
                                    threadId: thread.id || '',
                                    snippet: thread.snippet || '',
                                    historyId: thread.historyId || '',
                                    messageCount: messages.length,
                                    latestMessage: {
                                        from: latestHeaders.find((h: any) => h.name === 'From')?.value || '',
                                        subject: latestHeaders.find((h: any) => h.name === 'Subject')?.value || '',
                                        date: latestHeaders.find((h: any) => h.name === 'Date')?.value || '',
                                    },
                                };
                            })
                        );

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        resultCount: threadSummaries.length,
                                        threads: threadSummaries,
                                    }, null, 2),
                                },
                            ],
                        };
                    }

                    // Expand each thread with full message content (parallel fetch)
                    const expandedThreads = await Promise.all(
                        threads.map(async (thread: any) => {
                            const threadDetail = await gmail.users.threads.get({
                                userId: 'me',
                                id: thread.id!,
                                format: 'full',
                            });

                            const threadMessages = threadDetail.data.messages || [];

                            const messages = threadMessages.map((msg: any) => {
                                const headers = msg.payload?.headers || [];
                                const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                                const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                                const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
                                const cc = headers.find((h: any) => h.name?.toLowerCase() === 'cc')?.value || '';
                                const bcc = headers.find((h: any) => h.name?.toLowerCase() === 'bcc')?.value || '';
                                const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';

                                const { text, html } = extractEmailContent(msg.payload as GmailMessagePart || {});
                                const body = text || html || '';

                                // Extract attachment metadata
                                const attachments: EmailAttachment[] = [];
                                const processAttachmentParts = (part: GmailMessagePart) => {
                                    if (part.body && part.body.attachmentId) {
                                        const filename = part.filename || `attachment-${part.body.attachmentId}`;
                                        attachments.push({
                                            id: part.body.attachmentId,
                                            filename: filename,
                                            mimeType: part.mimeType || 'application/octet-stream',
                                            size: part.body.size || 0,
                                        });
                                    }
                                    if (part.parts) {
                                        part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
                                    }
                                };
                                if (msg.payload) {
                                    processAttachmentParts(msg.payload as GmailMessagePart);
                                }

                                return {
                                    messageId: msg.id || '',
                                    threadId: msg.threadId || '',
                                    from,
                                    to,
                                    cc,
                                    bcc,
                                    subject,
                                    date,
                                    body,
                                    labelIds: msg.labelIds || [],
                                    attachments: attachments.map(a => ({
                                        filename: a.filename,
                                        mimeType: a.mimeType,
                                        size: a.size,
                                    })),
                                };
                            });

                            return {
                                threadId: thread.id || '',
                                messageCount: messages.length,
                                messages,
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    resultCount: expandedThreads.length,
                                    threads: expandedThreads,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "reply_all": {
                    const validatedArgs = ReplyAllSchema.parse(args);

                    // Fetch the original email to get headers
                    const originalEmail = await gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    });

                    const headers = originalEmail.data.payload?.headers || [];
                    const threadId = originalEmail.data.threadId || '';

                    // Extract relevant headers
                    const originalFrom = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                    const originalTo = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
                    const originalCc = headers.find((h: any) => h.name?.toLowerCase() === 'cc')?.value || '';
                    const originalSubject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                    const originalMessageId = headers.find((h: any) => h.name?.toLowerCase() === 'message-id')?.value || '';
                    const originalReferences = headers.find((h: any) => h.name?.toLowerCase() === 'references')?.value || '';

                    // Get authenticated user's email to exclude from recipients
                    const profile = await gmail.users.getProfile({ userId: 'me' });
                    const myEmail = profile.data.emailAddress?.toLowerCase() || '';

                    // Build recipient list using helper functions
                    const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
                        originalFrom,
                        originalTo,
                        originalCc,
                        myEmail
                    );

                    if (replyTo.length === 0) {
                        throw new Error('Could not determine recipient for reply');
                    }

                    // Build subject with "Re:" prefix if not already present
                    const replySubject = addRePrefix(originalSubject);

                    // Build References header (original References + original Message-ID)
                    const references = buildReferencesHeader(originalReferences, originalMessageId);

                    // Prepare the email arguments for handleEmailAction
                    const emailArgs = {
                        to: replyTo,
                        cc: replyCc.length > 0 ? replyCc : undefined,
                        subject: replySubject,
                        body: validatedArgs.body,
                        htmlBody: validatedArgs.htmlBody,
                        mimeType: validatedArgs.mimeType,
                        threadId: threadId,
                        inReplyTo: originalMessageId,
                        attachments: validatedArgs.attachments,
                    };

                    // Use the existing handleEmailAction to send the reply
                    const result = await handleEmailAction("send", emailArgs);

                    // Enhance the response with reply-all specific info
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Reply-all sent successfully!\nTo: ${replyTo.join(', ')}${replyCc.length > 0 ? `\nCC: ${replyCc.join(', ')}` : ''}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
                            },
                        ],
                    };
                }

                case "modify_thread": {
                    const validatedArgs = ModifyThreadSchema.parse(args);

                    // Prepare request body for threads.modify
                    const modifyRequestBody: any = {};

                    if (validatedArgs.addLabelIds) {
                        modifyRequestBody.addLabelIds = validatedArgs.addLabelIds;
                    }

                    if (validatedArgs.removeLabelIds) {
                        modifyRequestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    await gmail.users.threads.modify({
                        userId: 'me',
                        id: validatedArgs.threadId,
                        requestBody: modifyRequestBody,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${validatedArgs.threadId} labels updated successfully (all messages in thread modified)`,
                            },
                        ],
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    });

        return server;
    }

    if (process.argv.includes('--sse')) {
        const portArg = process.argv.find(arg => arg.startsWith('--port='));
        const port = portArg ? parseInt(portArg.slice('--port='.length), 10) : 8080;
        
        const app = express();
        app.set("trust proxy", true);
        const activeTransports = new Map<string, SSEServerTransport>();

        const apiKey = process.env.GMAIL_MCP_API_KEY;
        if (apiKey) {
            console.log("Securing remote MCP endpoints with GMAIL_MCP_API_KEY-backed OAuth.");
        }

        const requireRemoteAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (apiKey && !isRemoteRequestAuthorized(req)) {
                sendRemoteAuthChallenge(req, res);
                return;
            }
            next();
        };

        const readAuthorizeParams = (source: Record<string, any>) => ({
            response_type: queryValue(source.response_type) || "",
            client_id: queryValue(source.client_id) || "",
            redirect_uri: queryValue(source.redirect_uri) || "",
            scope: queryValue(source.scope) || REMOTE_MCP_SCOPE,
            state: queryValue(source.state) || "",
            code_challenge: queryValue(source.code_challenge) || "",
            code_challenge_method: queryValue(source.code_challenge_method) || "",
        });

        const validateAuthorizeParams = (params: ReturnType<typeof readAuthorizeParams>): string | undefined => {
            if (params.response_type !== "code") {
                return "Unsupported response_type.";
            }
            const client = registeredOAuthClients.get(params.client_id);
            if (!client) {
                return "Unknown OAuth client.";
            }
            if (!client.redirectUris.includes(params.redirect_uri)) {
                return "redirect_uri is not registered for this OAuth client.";
            }
            try {
                new URL(params.redirect_uri);
            } catch {
                return "redirect_uri must be an absolute URL.";
            }
            if (!params.code_challenge || params.code_challenge_method !== "S256") {
                return "PKCE S256 is required.";
            }
            return undefined;
        };

        app.get("/.well-known/oauth-protected-resource", (req, res) => {
            res.json(protectedResourceMetadata(req));
        });

        app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
            res.json(protectedResourceMetadata(req));
        });

        app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (req, res) => {
            res.json(oauthAuthorizationServerMetadata(req));
        });

        app.post("/register", express.json({ type: ["application/json", "application/*+json"] }), (req, res) => {
            const redirectUris = Array.isArray(req.body?.redirect_uris)
                ? req.body.redirect_uris.filter((uri: unknown): uri is string => typeof uri === "string")
                : [];

            if (redirectUris.length === 0) {
                sendOAuthError(res, 400, "invalid_client_metadata", "redirect_uris must contain at least one URI.");
                return;
            }

            const createdAt = Date.now();
            const clientId = `client_${randomUUID()}`;
            const client: RegisteredOAuthClient = {
                clientId,
                redirectUris,
                clientName: typeof req.body?.client_name === "string" ? req.body.client_name : undefined,
                createdAt,
            };
            registeredOAuthClients.set(clientId, client);

            noStore(res).status(201).json({
                client_id: clientId,
                client_id_issued_at: Math.floor(createdAt / 1000),
                redirect_uris: redirectUris,
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
            });
        });

        app.get("/authorize", (req, res) => {
            const params = readAuthorizeParams(req.query as Record<string, any>);
            const validationError = validateAuthorizeParams(params);
            if (validationError) {
                res.status(400).send(validationError);
                return;
            }
            res.type("html").send(renderAuthorizeForm(params));
        });

        app.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
            const params = readAuthorizeParams(req.body as Record<string, any>);
            const validationError = validateAuthorizeParams(params);
            if (validationError) {
                res.status(400).send(validationError);
                return;
            }

            const configuredKey = getConfiguredRemoteApiKey();
            const submittedKey = typeof req.body?.api_key === "string" ? req.body.api_key : "";
            if (!configuredKey || !submittedKey || !timingSafeStringEquals(submittedKey, configuredKey)) {
                res.status(401).type("html").send(renderAuthorizeForm(params, "Invalid API key."));
                return;
            }

            const code = randomToken();
            pendingAuthCodes.set(code, {
                clientId: params.client_id,
                redirectUri: params.redirect_uri,
                codeChallenge: params.code_challenge,
                codeChallengeMethod: params.code_challenge_method,
                scope: REMOTE_MCP_SCOPE,
                expiresAt: Date.now() + AUTH_CODE_TTL_MS,
            });

            const redirectUrl = new URL(params.redirect_uri);
            redirectUrl.searchParams.set("code", code);
            if (params.state) {
                redirectUrl.searchParams.set("state", params.state);
            }
            res.redirect(302, redirectUrl.toString());
        });

        app.get("/oauth2callback", async (req, res) => {
            const googleError = queryValue(req.query.error);
            if (googleError) {
                noStore(res)
                    .status(400)
                    .type("html")
                    .send(renderGmailOAuthResultPage(false, `Google OAuth failed: ${googleError}`));
                return;
            }

            try {
                const result = await completeGmailOAuthCallback({
                    code: queryValue(req.query.code),
                    state: queryValue(req.query.state),
                });

                noStore(res)
                    .status(200)
                    .type("html")
                    .send(renderGmailOAuthResultPage(
                        true,
                        `Gmail authentication successful for ${result.accountEmail}; you can return to Claude/Cowork.`,
                    ));
            } catch (error) {
                const message = error instanceof Error ? error.message : "Gmail authentication failed.";
                const status = error instanceof GmailOAuthError ? error.statusCode : 500;
                noStore(res)
                    .status(status)
                    .type("html")
                    .send(renderGmailOAuthResultPage(false, message));
            }
        });

        app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
            cleanupRemoteAuthStores();

            const grantType = req.body?.grant_type;
            if (grantType === "authorization_code") {
                const codeValue = typeof req.body?.code === "string" ? req.body.code : "";
                const code = pendingAuthCodes.get(codeValue);
                if (!code || code.expiresAt <= Date.now()) {
                    sendOAuthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
                    return;
                }

                const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
                const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "";
                const codeVerifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";

                if (clientId !== code.clientId || redirectUri !== code.redirectUri) {
                    sendOAuthError(res, 400, "invalid_grant", "Authorization code client or redirect_uri mismatch.");
                    return;
                }
                if (!codeVerifier || pkceS256(codeVerifier) !== code.codeChallenge) {
                    sendOAuthError(res, 400, "invalid_grant", "PKCE verification failed.");
                    return;
                }

                pendingAuthCodes.delete(codeValue);
                noStore(res).json(issueRemoteTokens(clientId, code.scope));
                return;
            }

            if (grantType === "refresh_token") {
                const refreshTokenValue = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : "";
                const refreshToken = issuedRefreshTokens.get(refreshTokenValue);
                if (!refreshToken || refreshToken.expiresAt <= Date.now()) {
                    sendOAuthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
                    return;
                }

                const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
                if (clientId && clientId !== refreshToken.clientId) {
                    sendOAuthError(res, 400, "invalid_grant", "Refresh token client mismatch.");
                    return;
                }

                issuedRefreshTokens.delete(refreshTokenValue);
                noStore(res).json(issueRemoteTokens(refreshToken.clientId, refreshToken.scope));
                return;
            }

            sendOAuthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token grants are supported.");
        });

        app.all("/mcp", express.json({ type: ["application/json", "application/*+json"] }), async (req, res) => {
            if (apiKey && !isRemoteRequestAuthorized(req)) {
                sendRemoteAuthChallenge(req, res);
                return;
            }

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            const sessionServer = createMcpServer({ gmailOAuthPublicBaseUrl: getRequestBaseUrl(req) });

            try {
                await sessionServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                console.error("Streamable HTTP MCP request failed:", (error as any).message);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: "2.0",
                        error: { code: -32603, message: "Internal error" },
                        id: null,
                    });
                }
            } finally {
                try {
                    await sessionServer.close();
                } catch {
                    // Ignore errors during close
                }
            }
        });

        app.get("/sse", requireRemoteAuth, async (req, res) => {
            console.log(`Client connecting to ${req.path}...`);
            const queryApiKey = queryValue(req.query.api_key);
            const endpoint = apiKey && queryApiKey && timingSafeStringEquals(queryApiKey, apiKey)
                ? `/messages?api_key=${encodeURIComponent(queryApiKey)}`
                : "/messages";
            const transport = new SSEServerTransport(endpoint, res);
            
            const sessionServer = createMcpServer({ gmailOAuthPublicBaseUrl: getRequestBaseUrl(req) });
            
            activeTransports.set(transport.sessionId, transport);
            transport.onclose = async () => {
                console.log(`SSE transport closed for session ${transport.sessionId}`);
                activeTransports.delete(transport.sessionId);
                try {
                    await sessionServer.close();
                } catch (e) {
                    // Ignore errors during close
                }
            };

            await sessionServer.connect(transport);
            console.log(`SSE transport connected for session ${transport.sessionId}`);
        });

        app.post("/messages", requireRemoteAuth, express.json(), async (req, res) => {
            const sessionId = req.query.sessionId as string;
            const transport = activeTransports.get(sessionId);
            if (transport) {
                await transport.handlePostMessage(req, res);
            } else {
                res.status(400).send("Invalid session ID or session has expired");
            }
        });

        app.listen(port, () => {
            console.log(`Gmail MCP Server successfully started in remote mode on port ${port}`);
            console.log(`Streamable HTTP endpoint: http://localhost:${port}/mcp`);
            console.log(`Legacy SSE endpoint: http://localhost:${port}/sse`);
        });
    } else {
        const server = createMcpServer();
        const transport = new StdioServerTransport();
        server.connect(transport);
    }
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
