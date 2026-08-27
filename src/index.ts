#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { gmail as createGmailClient } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import type { Server as HttpServer } from 'node:http';
import {createEmailMessage, createEmailWithNodemailer, needsRawBuilder} from "./utl.js";
import {
    loadScheduledAttachments,
    MAX_MANAGED_EXPORT_FILE_BYTES,
    safeSuggestedFilename,
    validateManagedExportFilename,
    writeManagedExportFile,
} from './managed-files.js';
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel, GmailLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates, GmailFilterCriteria, GmailFilterAction } from "./filter-manager.js";
import { parseEmailAddresses, filterOutEmail, addRePrefix, buildReferencesHeader, buildReplyAllRecipients } from "./reply-all-helpers.js";
import { DEFAULT_SCOPES, parseScopes, validateScopes, hasScope, getAvailableScopeNames } from "./scopes.js";
import { toolDefinitions, toMcpTools, getToolByName, SendEmailSchema, ReadEmailSchema, SearchEmailsSchema, ModifyEmailSchema, DeleteEmailSchema, BatchModifyEmailsSchema, ReportPhishingSchema, BatchReportPhishingSchema, BatchDeleteEmailsSchema, CreateLabelSchema, UpdateLabelSchema, DeleteLabelSchema, GetOrCreateLabelSchema, CreateFilterSchema, GetFilterSchema, DeleteFilterSchema, CreateFilterFromTemplateSchema, DownloadAttachmentSchema, ReplyAllSchema, GetThreadSchema, ListInboxThreadsSchema, GetInboxWithThreadsSchema, DownloadEmailSchema, ModifyThreadSchema, SendDraftSchema, DeleteDraftSchema, UpdateDraftSchema, ScheduleEmailSchema, ListScheduledEmailsSchema, CancelScheduledEmailSchema, ResolveUncertainScheduledEmailSchema, AuthenticateAccountSchema } from "./tools.js";
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
    loadGmailCredentialsIntoClient,
    loadOAuthKeys,
    startLocalGmailOAuthFlow,
    startRemoteGmailOAuthFlow,
} from "./gmail-oauth.js";
import {
    listAuthenticatedAccounts,
    isAccountAuthenticated,
    getAccountCredentialsPath,
    canonicalizeAccountEmail,
    loadQueue,
    enqueueScheduledEmail,
    cancelScheduledEmail,
    claimScheduledEmail,
    markScheduledEmailFailed,
    markScheduledEmailSent,
    markScheduledEmailUncertain,
    recoverInterruptedScheduledEmails,
    resolveUncertainScheduledEmail,
    acquireSchedulerLease,
    ensureDirectories,
    ScheduledEmail
} from "./db.js";
import { closeDefaultOAuthStateStore, getDefaultOAuthStateStore } from './oauth-store.js';
import { createRemoteHttpApp, loadRemoteServerConfig } from './remote-http.js';
import { resolveToolPrefix } from "./tool-prefix.js";


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

    if (!fs.existsSync(credPath)) {
        throw new Error(`Credentials file not found at ${credPath}`);
    }
    const credentials = loadGmailCredentialsIntoClient(oauthClient, credPath);

    const gmail = createGmailClient({ version: 'v1', auth: oauthClient });
    return { gmail, authorizedScopes: credentials.scopes, oauthClient };
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
    const lease = acquireSchedulerLease(CONFIG_DIR);
    try {
        console.log('Starting Gmail MCP Scheduler Daemon...');
        ensureDirectories();

        const interruptedCount = recoverInterruptedScheduledEmails();
        if (interruptedCount > 0) {
            console.error(
                `Marked ${interruptedCount} interrupted scheduled email(s) as uncertain; they will not be sent again automatically.`,
            );
        }

        while (true) {
        const now = new Date();
        const pending = loadQueue().filter(
            item => item.status === 'pending' && new Date(item.scheduledTime) <= now,
        );

        if (pending.length > 0) {
            console.log(`Found ${pending.length} pending scheduled emails to send.`);

            for (const candidate of pending) {
                const jitter = Math.floor(Math.random() * 40000) + 5000;
                console.log(`Scheduling send for email ID ${candidate.id} from ${candidate.account} with random organic jitter of ${Math.round(jitter/1000)}s...`);
                await new Promise(resolve => setTimeout(resolve, jitter));

                const email = claimScheduledEmail(candidate.id);
                if (!email) continue;

                let gmail: any;
                let encodedMessage: string;
                try {
                    ({ gmail } = await getAccountClient(email.account));
                    const rawMessage = email.attachments && email.attachments.length > 0
                        ? await createEmailWithNodemailer({
                            to: email.to,
                            subject: email.subject,
                            body: email.body,
                            htmlBody: email.htmlBody,
                            cc: email.cc,
                            bcc: email.bcc,
                            threadId: email.threadId,
                            inReplyTo: email.inReplyTo,
                        }, loadScheduledAttachments(email.id, email.attachments, CONFIG_DIR))
                        : createEmailMessage({
                            to: email.to,
                            subject: email.subject,
                            body: email.body,
                            htmlBody: email.htmlBody,
                            cc: email.cc,
                            bcc: email.bcc,
                            threadId: email.threadId,
                            inReplyTo: email.inReplyTo,
                        });
                    encodedMessage = Buffer.from(rawMessage).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');
                } catch (preflightError) {
                    const message = (preflightError as Error).message;
                    markScheduledEmailFailed(email.id, message);
                    console.error(`Scheduled email ${email.id} failed before Gmail send:`, message);
                    continue;
                }

                console.log(`Sending email ${email.id} using account ${email.account}...`);
                let result: any;
                try {
                    result = await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: {
                            raw: encodedMessage,
                            ...(email.threadId && { threadId: email.threadId }),
                        },
                    });
                } catch (sendError) {
                    const message = (sendError as Error).message;
                    markScheduledEmailUncertain(
                        email.id,
                        `Gmail send did not return a definitive result: ${message}`,
                    );
                    console.error(
                        `Delivery outcome for scheduled email ${email.id} is uncertain; it will not be retried automatically:`,
                        message,
                    );
                    continue;
                }

                markScheduledEmailSent(email.id, result.data.id);
                console.log(`Successfully sent email ID ${email.id}! Gmail Message ID: ${result.data.id}`);
            }
        }

            const checkSleep = Math.floor(50000 + Math.random() * 20000);
            console.log(`Scheduler sleeping for ${Math.round(checkSleep/1000)} seconds before next queue check...`);
            await new Promise(resolve => setTimeout(resolve, checkSleep));
        }
    } finally {
        lease.release();
    }
}

const DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS = 10_000;

function getHttpShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = env.GMAIL_MCP_SHUTDOWN_TIMEOUT_MS?.trim();
    if (!configured) return DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS;
    const milliseconds = Number(configured);
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 300_000) {
        throw new Error('GMAIL_MCP_SHUTDOWN_TIMEOUT_MS must be an integer from 1 to 300000.');
    }
    return milliseconds;
}

function installGracefulHttpShutdown(
    listener: HttpServer,
    closeResources: () => void,
    timeoutMs = getHttpShutdownTimeoutMs(),
): void {
    let shutdownStarted = false;
    let shutdownFinished = false;
    let resourcesClosed = false;

    const closeResourcesOnce = (): Error | undefined => {
        if (resourcesClosed) return undefined;
        resourcesClosed = true;
        try {
            closeResources();
            return undefined;
        } catch (error) {
            return error as Error;
        }
    };

    const forceShutdown = (reason: string): void => {
        if (shutdownFinished) return;
        shutdownFinished = true;
        console.error(reason);
        listener.closeAllConnections();
        const resourceError = closeResourcesOnce();
        if (resourceError) console.error('Failed to close OAuth state store:', resourceError.message);
        process.exit(1);
    };

    const beginShutdown = (signal: NodeJS.Signals): void => {
        if (shutdownStarted) {
            forceShutdown(`Received ${signal} while shutting down; forcing HTTP server closure.`);
            return;
        }
        shutdownStarted = true;
        console.log(`Received ${signal}; stopping HTTP accepts and draining active requests.`);

        const deadline = setTimeout(() => {
            forceShutdown(`HTTP shutdown deadline of ${timeoutMs}ms expired; forcing active connections closed.`);
        }, timeoutMs);

        listener.close(error => {
            if (shutdownFinished) return;
            shutdownFinished = true;
            clearTimeout(deadline);
            const resourceError = closeResourcesOnce();
            if (error) console.error('HTTP server close failed:', error.message);
            if (resourceError) console.error('Failed to close OAuth state store:', resourceError.message);
            process.exitCode = error || resourceError ? 1 : 0;
            console.log('HTTP server shutdown complete.');
        });
        listener.closeIdleConnections();
    };

    process.once('SIGTERM', beginShutdown);
    process.once('SIGINT', beginShutdown);
}

// Optional tool-name prefix — lets multiple instances of this server run side-by-side
// without their tool names colliding in clients that disambiguate by base name.
// Precedence: --tool-prefix=<value> / --tool-prefix <value> CLI flag, then
// GMAIL_MCP_TOOL_PREFIX env var, then empty (no prefix → backward compatible).
// Does not affect the `auth` subcommand, which is detected via process.argv[2] === 'auth'
// and exits before the server starts — run `auth` without --tool-prefix.
const TOOL_PREFIX = resolveToolPrefix(process.argv.slice(2), process.env);

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
        const oauthClient = createGmailOAuthClient(callbackUrl, keys);

        if (fs.existsSync(CREDENTIALS_PATH)) {
            loadGmailCredentialsIntoClient(oauthClient, CREDENTIALS_PATH);
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

    interface McpServerOptions {
        gmailOAuthPublicBaseUrl?: string;
    }

    // Function to create a server instance and register all handlers
    function createMcpServer(options: McpServerOptions = {}): Server {
        const server = new Server(
            {
                name: "gmail",
                version: "2.0.0",
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
        const mcpTools = toMcpTools(availableTools);
        // Apply optional TOOL_PREFIX so multiple server instances can coexist
        // in clients that dedupe tool entries by base name.
        return { tools: mcpTools.map(t => ({ ...t, name: TOOL_PREFIX + t.name })) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name: rawName, arguments: args } = request.params;

        // A configured prefix is part of the callable tool name, not only its
        // advertised alias. This keeps side-by-side instances isolated.
        const name = TOOL_PREFIX
            ? (rawName.startsWith(TOOL_PREFIX)
                ? rawName.slice(TOOL_PREFIX.length)
                : '')
            : rawName;
        const validatedArgs = args as any;

        const toolDef = name ? getToolByName(name) : undefined;
        if (!toolDef) {
            return {
                isError: true,
                content: [{
                    type: "text",
                    text: `Error: Tool "${rawName}" is not found.`,
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
                    isError: true,
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
                isError: true,
                content: [{
                    type: "text",
                    text: `Error resolving Gmail client: ${(error as any).message}`,
                }],
            };
        }

        const { gmail, authorizedScopes } = gmailClientInfo;

        if (!hasScope(authorizedScopes, toolDef.scopes)) {
            return {
                isError: true,
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

                // Route attachment- or inline-image-bearing mail through the raw MIME builder
                if (needsRawBuilder(validatedArgs)) {
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
                    // For plain / simple-HTML mail with no attachments or inline images
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
                // Log attachment / inline-image errors for debugging
                if (needsRawBuilder(validatedArgs)) {
                    const nAtt = validatedArgs.attachments?.length || 0;
                    const nImg = validatedArgs.inlineImages?.length || 0;
                    console.error(`Failed to send email with ${nAtt} attachment(s) and ${nImg} inline image(s):`, error.message);
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
                    
                    let account = scheduleArgs.account
                        ? canonicalizeAccountEmail(scheduleArgs.account)
                        : undefined;
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
                        scheduledTime: targetTime,
                        status: 'pending',
                        attempts: 0
                    };
                    
                    enqueueScheduledEmail(
                        newEmail,
                        scheduleArgs.attachments ?? [],
                        scheduleArgs.inlineImages ?? [],
                    );
                    
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
                    if (!cancelScheduledEmail(cancelArgs.id)) {
                        return {
                            isError: true,
                            content: [{
                                type: "text",
                                text: `Error: Scheduled email with ID "${cancelArgs.id}" was not found or is no longer pending.`,
                            }],
                        };
                    }
                    
                    return {
                        content: [{
                            type: "text",
                            text: `Successfully cancelled scheduled email with ID "${cancelArgs.id}".`,
                        }],
                    };
                }
                case "resolve_uncertain_scheduled_email": {
                    const resolveArgs = ResolveUncertainScheduledEmailSchema.parse(args);
                    const resolved = resolveUncertainScheduledEmail(
                        resolveArgs.id,
                        resolveArgs.outcome,
                        resolveArgs.gmailMessageId,
                    );
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify(resolved, null, 2),
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

                        const filename = safeSuggestedFilename(
                            `${messageId}.${format}`,
                            `email.${format}`,
                        );
                        const exported = writeManagedExportFile(filename, content, savePath, CONFIG_DIR);

                        // Return metadata with attachments
                        const result = {
                            status: "saved",
                            path: exported.path,
                            size: exported.size,
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
                            isError: true,
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
                    if (needsRawBuilder(messageArgs)) {
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
                        const estimatedDecodedBytes = Math.floor(data.length * 3 / 4);
                        if (estimatedDecodedBytes > MAX_MANAGED_EXPORT_FILE_BYTES) {
                            throw new Error(
                                `Attachment exceeds the ${MAX_MANAGED_EXPORT_FILE_BYTES}-byte managed export limit.`,
                            );
                        }
                        const buffer = Buffer.from(data, 'base64url');

                        // Determine the filename. The destination is always the managed export root.
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

                        filename = validatedArgs.filename
                            ? validateManagedExportFilename(filename)
                            : safeSuggestedFilename(
                                filename,
                                `attachment-${validatedArgs.attachmentId}`,
                            );
                        const exported = writeManagedExportFile(
                            filename,
                            buffer,
                            validatedArgs.savePath,
                            CONFIG_DIR,
                        );

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Attachment downloaded successfully:\nFile: ${path.basename(exported.path)}\nSize: ${exported.size} bytes\nSaved to: ${exported.path}`,
                                },
                            ],
                        };
                    } catch (error: any) {
                        return {
                            isError: true,
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
                        inlineImages: validatedArgs.inlineImages,
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
                isError: true,
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

    const legacySseFlag = process.argv.includes('--sse');
    if (process.argv.includes('--http') || legacySseFlag) {
        if (legacySseFlag) {
            console.warn('--sse is a deprecated alias for Streamable HTTP; use --http and connect to /mcp.');
        }
        const readCliOption = (name: string, fallback: string): string => {
            const inline = process.argv.find(arg => arg.startsWith(`--${name}=`));
            if (inline) return inline.slice(name.length + 3);
            const index = process.argv.indexOf(`--${name}`);
            return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
        };
        const host = readCliOption('host', '127.0.0.1');
        const port = Number(readCliOption('port', '8080'));
        if (!host.trim()) throw new Error('--host must not be empty.');
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('--port must be an integer between 1 and 65535.');
        }

        const config = loadRemoteServerConfig();
        const stateStore = getDefaultOAuthStateStore();
        stateStore.cleanupExpired();

        const app = createRemoteHttpApp(config, stateStore, {
            completeGmailOAuthCallback: params => completeGmailOAuthCallback({
                ...params,
                stateStore,
            }),
            handleMcpRequest: async (req, res) => {
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true,
                });
                const sessionServer = createMcpServer({
                    gmailOAuthPublicBaseUrl: config.issuerUrl,
                });

                try {
                    await sessionServer.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                } catch (error) {
                    console.error('Streamable HTTP MCP request failed:', (error as Error).message);
                    if (!res.headersSent) {
                        res.status(500).json({
                            jsonrpc: '2.0',
                            error: { code: -32603, message: 'Internal error' },
                            id: null,
                        });
                    }
                } finally {
                    try {
                        await sessionServer.close();
                    } catch {
                        // The request response has already been finalized.
                    }
                }
            },
        });

        const listener = await new Promise<HttpServer>((resolve, reject) => {
            const listener = app.listen(port, host);
            listener.once('error', reject);
            listener.once('listening', () => {
                console.log(`Gmail MCP Server listening on http://${host}:${port}`);
                console.log(`Streamable HTTP endpoint: ${config.resourceUrl}`);
                resolve(listener);
            });
        });
        installGracefulHttpShutdown(listener, closeDefaultOAuthStateStore);
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
