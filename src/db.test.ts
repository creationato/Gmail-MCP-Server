import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousStateDirectory = process.env.GMAIL_MCP_STATE_DIR;
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-queue-test-'));
process.env.GMAIL_MCP_STATE_DIR = stateDirectory;

const {
    cancelScheduledEmail,
    canonicalizeAccountEmail,
    claimScheduledEmail,
    enqueueScheduledEmail,
    getAccountCredentialsPath,
    LEGACY_MIGRATION_FAILURE_MESSAGE,
    loadQueue,
    markScheduledEmailFailed,
    markScheduledEmailSent,
    markScheduledEmailUncertain,
    MAX_QUEUE_DOCUMENT_BYTES,
    MAX_SCHEDULED_BODY_CHARS,
    MAX_SCHEDULED_QUEUE_RECORDS,
    MAX_SCHEDULED_RECIPIENTS,
    QUEUE_SCHEMA_VERSION,
    recoverInterruptedScheduledEmails,
    resolveUncertainScheduledEmail,
    UNCERTAIN_ATTACHMENT_RETENTION_MS,
} = await import('./db.js');
const {
    ensureManagedFileDirectories,
    getManagedImportDirectory,
    getScheduledAttachmentsDirectory,
    loadScheduledAttachments,
    spoolScheduledAttachments,
} = await import('./managed-files.js');

const queuePath = path.join(stateDirectory, 'scheduled_queue.json');
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
    'base64',
);
const JPEG_BYTES = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00, 0xff, 0xd9,
]);

function scheduledEmail(id: string) {
    return {
        id,
        account: 'user@gmail.com',
        to: ['recipient@example.com'],
        subject: `Subject ${id}`,
        body: 'Body',
        scheduledTime: '2026-01-01T00:00:00.000Z',
        status: 'pending' as const,
        attempts: 0,
    };
}

function writeQueue(value: unknown): void {
    fs.writeFileSync(queuePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readPersistedQueue(): any {
    return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
}

function writeImport(name: string, contents: string | Buffer): string {
    ensureManagedFileDirectories(stateDirectory);
    const filePath = path.join(getManagedImportDirectory(stateDirectory), name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    return filePath;
}

function bundleDirectory(record: { relativePath: string }): string {
    return path.dirname(path.join(stateDirectory, ...record.relativePath.split('/')));
}

beforeEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    if (previousStateDirectory === undefined) delete process.env.GMAIL_MCP_STATE_DIR;
    else process.env.GMAIL_MCP_STATE_DIR = previousStateDirectory;
});

describe('versioned scheduled queue persistence', () => {
    it('serializes mutations and persists an explicit schema version', () => {
        enqueueScheduledEmail(scheduledEmail('first'));
        enqueueScheduledEmail(scheduledEmail('second'));

        expect(loadQueue().map(email => email.id)).toEqual(['first', 'second']);
        expect(readPersistedQueue()).toMatchObject({
            version: QUEUE_SCHEMA_VERSION,
            records: [{ id: 'first' }, { id: 'second' }],
        });
        expect(() => enqueueScheduledEmail(scheduledEmail('first'))).toThrow('already exists');
        expect(cancelScheduledEmail('first')).toBe(true);
        expect(loadQueue().map(email => email.id)).toEqual(['second']);
    });

    it('allows one durable claim and never returns an interrupted send to pending', () => {
        enqueueScheduledEmail(scheduledEmail('send-once'));
        const claimTime = new Date('2026-02-01T00:00:00.000Z');

        expect(claimScheduledEmail('send-once', claimTime)).toMatchObject({
            status: 'sending',
            attempts: 1,
            lastAttemptTime: claimTime.toISOString(),
        });
        expect(claimScheduledEmail('send-once', claimTime)).toBeUndefined();
        expect(recoverInterruptedScheduledEmails(new Date('2026-02-01T00:01:00.000Z'))).toBe(1);
        expect(loadQueue()[0]).toMatchObject({ id: 'send-once', status: 'uncertain', attempts: 1 });
        expect(claimScheduledEmail('send-once', new Date('2026-03-01'))).toBeUndefined();
        expect(cancelScheduledEmail('send-once')).toBe(false);
        expect(() => markScheduledEmailSent('send-once', 'gmail-id')).toThrow(
            'cannot be finalized from status "uncertain"',
        );
    });

    it('propagates atomic replacement failure and leaves the prior queue intact', () => {
        enqueueScheduledEmail(scheduledEmail('preserved'));
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(destination.toString()) === path.resolve(queuePath)) {
                throw new Error('simulated queue rename failure');
            }
            renameSync(source, destination);
        });

        expect(() => enqueueScheduledEmail(scheduledEmail('not-persisted')))
            .toThrow('simulated queue rename failure');
        vi.restoreAllMocks();

        expect(loadQueue().map(email => email.id)).toEqual(['preserved']);
        expect(fs.readdirSync(stateDirectory).some(name => name.endsWith('.tmp'))).toBe(false);
        expect(fs.existsSync(`${queuePath}.lock`)).toBe(false);
    });

    it('rejects malformed, oversized, symlinked, and multiply linked queue files', () => {
        fs.writeFileSync(queuePath, '{not-json', { mode: 0o600 });
        expect(() => loadQueue()).toThrow(SyntaxError);
        expect(fs.readFileSync(queuePath, 'utf8')).toBe('{not-json');

        fs.rmSync(queuePath);
        fs.writeFileSync(queuePath, '', { mode: 0o600 });
        fs.truncateSync(queuePath, MAX_QUEUE_DOCUMENT_BYTES + 1);
        expect(() => loadQueue()).toThrow(/Scheduled queue exceeds/);

        fs.rmSync(queuePath);
        const credentials = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        fs.linkSync(credentials, queuePath);
        expect(() => loadQueue()).toThrow(/singly linked/);

        fs.rmSync(queuePath);
        fs.symlinkSync(credentials, queuePath);
        expect(() => loadQueue()).toThrow();
        expect(fs.readFileSync(credentials, 'utf8')).toBe('oauth-secret');
    });

    it('strictly validates version, unknown fields, statuses, ownership, and duplicate IDs', () => {
        const valid = scheduledEmail('strict');
        for (const document of [
            { version: QUEUE_SCHEMA_VERSION + 1, records: [] },
            { version: QUEUE_SCHEMA_VERSION, records: [{ ...valid, unexpected: true }] },
            { version: QUEUE_SCHEMA_VERSION, records: [{ ...valid, status: 'retrying' }] },
            { version: QUEUE_SCHEMA_VERSION, records: [valid, valid] },
        ]) {
            writeQueue(document);
            expect(() => loadQueue()).toThrow();
        }

        writeImport('owned.txt', 'owned bytes');
        const descriptors = spoolScheduledAttachments('actual-owner', ['owned.txt'], stateDirectory);
        writeQueue({
            version: QUEUE_SCHEMA_VERSION,
            records: [{ ...scheduledEmail('crafted-owner'), attachments: descriptors }],
        });
        expect(() => loadQueue()).toThrow();
    });

    it('enforces queue and field limits internally', () => {
        const records = Array.from(
            { length: MAX_SCHEDULED_QUEUE_RECORDS },
            (_, index) => scheduledEmail(`record-${index}`),
        );
        writeQueue({ version: QUEUE_SCHEMA_VERSION, records });
        expect(loadQueue()).toHaveLength(MAX_SCHEDULED_QUEUE_RECORDS);
        expect(() => enqueueScheduledEmail(scheduledEmail('one-too-many'))).toThrow(/queue limit/);

        writeQueue({ version: QUEUE_SCHEMA_VERSION, records: [] });
        expect(() => enqueueScheduledEmail({ ...scheduledEmail('no-recipient'), to: [] }))
            .toThrow(/recipient/);
        expect(() => enqueueScheduledEmail({ ...scheduledEmail('wrong-status'), status: 'sent' }))
            .toThrow(/start pending/);
        expect(() => enqueueScheduledEmail({
            ...scheduledEmail('too-many-recipients'),
            to: Array.from({ length: MAX_SCHEDULED_RECIPIENTS + 1 }, () => 'a@example.com'),
        })).toThrow();
        expect(() => enqueueScheduledEmail({
            ...scheduledEmail('body-too-large'),
            body: 'x'.repeat(MAX_SCHEDULED_BODY_CHARS + 1),
        })).toThrow();
    });
});

describe('legacy queue migration', () => {
    it('atomically migrates attachment-free records without changing their behavior', () => {
        const legacy = [scheduledEmail('legacy-plain')];
        writeQueue(legacy);

        expect(loadQueue()).toEqual(legacy);
        expect(readPersistedQueue()).toEqual({ version: QUEUE_SCHEMA_VERSION, records: legacy });
    });

    it('leaves the legacy document intact when atomic migration cannot commit', () => {
        const legacy = [scheduledEmail('legacy-preserved')];
        writeQueue(legacy);
        const original = fs.readFileSync(queuePath, 'utf8');
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(destination.toString()) === path.resolve(queuePath)) {
                throw new Error('migration commit failed');
            }
            renameSync(source, destination);
        });

        expect(() => loadQueue()).toThrow('migration commit failed');
        vi.restoreAllMocks();
        expect(fs.readFileSync(queuePath, 'utf8')).toBe(original);
    });

    it('spools safe legacy paths before migration so the queue survives source deletion', () => {
        const source = writeImport('legacy-attachment.txt', 'portable legacy bytes');
        writeQueue([{ ...scheduledEmail('legacy-attached'), attachments: ['legacy-attachment.txt'] }]);

        const [migrated] = loadQueue();
        expect(migrated.attachments).toHaveLength(1);
        expect(migrated.attachments![0]).toMatchObject({ ownerId: 'legacy-attached' });
        fs.unlinkSync(source);
        expect(loadScheduledAttachments(
            migrated.id,
            migrated.attachments!,
            stateDirectory,
        )[0].content.toString()).toBe('portable legacy bytes');
    });

    it('turns unsafe or invalid legacy items into redacted terminal failures', () => {
        const credentials = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        writeQueue([
            { ...scheduledEmail('unsafe-path'), attachments: [credentials] },
            { ...scheduledEmail('invalid-status'), status: 'retry-me' },
            'not-an-object',
        ]);

        const migrated = loadQueue();
        expect(migrated).toHaveLength(3);
        for (const record of migrated) {
            expect(record.status).toBe('failed');
            expect(record.errorMessage).toBe(LEGACY_MIGRATION_FAILURE_MESSAGE);
            expect(record.attachments).toBeUndefined();
        }
        const persisted = fs.readFileSync(queuePath, 'utf8');
        expect(persisted).not.toContain(credentials);
        expect(persisted).not.toContain('oauth-secret');
        expect(fs.readFileSync(credentials, 'utf8')).toBe('oauth-secret');
    });

    it('rejects a legacy hardlink to credentials without reading it', () => {
        const credentials = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        ensureManagedFileDirectories(stateDirectory);
        fs.linkSync(credentials, path.join(getManagedImportDirectory(stateDirectory), 'credential-link'));
        writeQueue([{ ...scheduledEmail('hardlinked-legacy'), attachments: ['credential-link'] }]);

        expect(loadQueue()[0]).toMatchObject({
            id: 'hardlinked-legacy',
            status: 'failed',
            errorMessage: LEGACY_MIGRATION_FAILURE_MESSAGE,
        });
        expect(fs.readFileSync(credentials, 'utf8')).toBe('oauth-secret');
    });
});

describe('scheduled attachment lifecycle', () => {
    it('persists inline images only as owner-bound descriptors and restores MIME metadata', () => {
        const source = writeImport('sources/scheduled-inline.png', PNG_BYTES);
        writeImport('regular.txt', 'regular attachment bytes');
        const encoded = JPEG_BYTES.toString('base64');
        const id = 'scheduled-inline-persistence';

        enqueueScheduledEmail(
            { ...scheduledEmail(id), htmlBody: '<img src="cid:path"><img src="cid:data">' },
            ['regular.txt'],
            [
                { cid: 'path', path: 'sources/scheduled-inline.png', contentType: 'image/png' },
                {
                    cid: 'data',
                    content: encoded,
                    contentType: 'image/jpeg',
                    filename: 'decoded.jpg',
                },
            ],
        );

        const persisted = fs.readFileSync(queuePath, 'utf8');
        expect(persisted).not.toContain('sources/scheduled-inline.png');
        expect(persisted).not.toContain(encoded);
        const queued = loadQueue()[0];
        expect(queued.attachments).toHaveLength(3);
        expect(queued.attachments?.map(part => part.cid)).toEqual([undefined, 'path', 'data']);
        expect(loadScheduledAttachments(id, queued.attachments!, stateDirectory)).toEqual([
            { filename: 'regular.txt', content: Buffer.from('regular attachment bytes') },
            {
                filename: 'scheduled-inline.png',
                content: PNG_BYTES,
                cid: 'path',
                contentType: 'image/png',
            },
            {
                filename: 'decoded.jpg',
                content: JPEG_BYTES,
                cid: 'data',
                contentType: 'image/jpeg',
            },
        ]);

        fs.unlinkSync(source);
        expect(cancelScheduledEmail(id)).toBe(true);
        expect(fs.readdirSync(getScheduledAttachmentsDirectory(stateDirectory))).toEqual([]);
    });

    it('detects scheduled inline-image descriptor and byte tampering', () => {
        expect(() => enqueueScheduledEmail(
            scheduledEmail('inline-without-html'),
            [],
            [{ cid: 'logo', content: 'AAAA', contentType: 'image/png' }],
        )).toThrow(/require htmlBody/);
        enqueueScheduledEmail(
            {
                ...scheduledEmail('inline-integrity'),
                htmlBody: '<img src="cid:logo"><img src="cid:second">',
            },
            [],
            [
                { cid: 'logo', content: PNG_BYTES.toString('base64'), contentType: 'image/png' },
                { cid: 'second', content: PNG_BYTES.toString('base64'), contentType: 'image/png' },
            ],
        );
        const queued = loadQueue()[0];
        const descriptor = queued.attachments![0];
        const spoolPath = path.join(stateDirectory, ...descriptor.relativePath.split('/'));
        fs.writeFileSync(spoolPath, 'tampered');
        expect(() => loadScheduledAttachments(queued.id, queued.attachments!, stateDirectory))
            .toThrow(/integrity/);

        const crafted = structuredClone(readPersistedQueue());
        crafted.records[0].attachments[1].cid = 'logo';
        writeQueue(crafted);
        expect(() => loadQueue()).toThrow(/cids must be unique/);
    });

    it('spools bytes before persistence and cleans them on cancellation', () => {
        const source = writeImport('scheduled.txt', 'scheduled attachment bytes');
        enqueueScheduledEmail(scheduledEmail('cancel-with-attachment'), ['scheduled.txt']);
        const queued = loadQueue()[0];
        expect(queued.attachments).toHaveLength(1);
        expect(path.isAbsolute(queued.attachments![0].relativePath)).toBe(false);

        fs.unlinkSync(source);
        expect(loadScheduledAttachments(
            queued.id,
            queued.attachments!,
            stateDirectory,
        )[0].content.toString()).toBe('scheduled attachment bytes');
        const spoolBundle = bundleDirectory(queued.attachments![0]);

        expect(cancelScheduledEmail(queued.id)).toBe(true);
        expect(fs.existsSync(spoolBundle)).toBe(false);
        expect(loadQueue()).toEqual([]);
    });

    it.each([
        ['sent', (id: string) => markScheduledEmailSent(id, 'gmail-id')],
        ['failed', (id: string) => markScheduledEmailFailed(id, 'preflight failed')],
    ])('cleans bytes after a definitive %s queue commit', (status, finalize) => {
        writeImport('terminal.txt', 'terminal bytes');
        const id = `terminal-${status}`;
        enqueueScheduledEmail(scheduledEmail(id), ['terminal.txt']);
        const descriptor = loadQueue()[0].attachments![0];
        const spoolBundle = bundleDirectory(descriptor);

        claimScheduledEmail(id, new Date('2026-02-01T00:00:00.000Z'));
        finalize(id);

        expect(fs.existsSync(spoolBundle)).toBe(false);
        expect(loadQueue()[0]).toMatchObject({
            status,
            attachmentMetadata: [{
                filename: descriptor.filename,
                size: descriptor.size,
                sha256: descriptor.sha256,
            }],
        });
        expect(loadQueue()[0].attachments).toBeUndefined();
    });

    it('retains uncertain bytes and immutable metadata until explicit reconciliation', () => {
        writeImport('uncertain.txt', 'uncertain bytes');
        const id = 'uncertain-resolution';
        const uncertainAt = new Date('2026-02-01T00:00:00.000Z');
        enqueueScheduledEmail(scheduledEmail(id), ['uncertain.txt']);
        claimScheduledEmail(id, uncertainAt);
        const descriptor = loadQueue()[0].attachments![0];
        const spoolBundle = bundleDirectory(descriptor);

        markScheduledEmailUncertain(id, 'Gmail response interrupted', uncertainAt);
        const uncertain = loadQueue(uncertainAt)[0];
        expect(fs.existsSync(spoolBundle)).toBe(true);
        expect(uncertain).toMatchObject({
            status: 'uncertain',
            attachments: [descriptor],
            attachmentMetadata: [{
                filename: descriptor.filename,
                size: descriptor.size,
                sha256: descriptor.sha256,
            }],
            attachmentRetentionExpiresAt: new Date(
                uncertainAt.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS,
            ).toISOString(),
        });

        const resolved = resolveUncertainScheduledEmail(id, 'sent', 'gmail-reconciled', uncertainAt);
        expect(resolved).toMatchObject({ status: 'sent', gmailMessageId: 'gmail-reconciled' });
        expect(resolved.attachments).toBeUndefined();
        expect(resolved.attachmentMetadata).toEqual(uncertain.attachmentMetadata);
        expect(fs.existsSync(spoolBundle)).toBe(false);
    });

    it('expires uncertain bytes at the retention boundary without losing metadata', () => {
        writeImport('retained.txt', 'retained bytes');
        const id = 'uncertain-expiry';
        const uncertainAt = new Date('2026-02-01T00:00:00.000Z');
        enqueueScheduledEmail(scheduledEmail(id), ['retained.txt']);
        claimScheduledEmail(id, uncertainAt);
        const descriptor = loadQueue(uncertainAt)[0].attachments![0];
        const spoolBundle = bundleDirectory(descriptor);
        markScheduledEmailUncertain(id, 'unknown result', uncertainAt);

        const justBefore = new Date(
            uncertainAt.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS - 1,
        );
        expect(loadQueue(justBefore)[0].attachments).toHaveLength(1);
        const atExpiry = new Date(uncertainAt.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS);
        const expired = loadQueue(atExpiry)[0];
        expect(expired.attachments).toBeUndefined();
        expect(expired.attachmentMetadata).toEqual([{
            filename: descriptor.filename,
            size: descriptor.size,
            sha256: descriptor.sha256,
        }]);
        expect(expired.attachmentRetentionExpiredAt).toBe(atExpiry.toISOString());
        expect(fs.existsSync(spoolBundle)).toBe(false);
        expect(resolveUncertainScheduledEmail(id, 'failed', undefined, atExpiry).status).toBe('failed');
    });

    it('does not delete spool bytes when a terminal queue commit fails', () => {
        writeImport('commit-first.txt', 'keep until commit');
        const id = 'commit-before-cleanup';
        enqueueScheduledEmail(scheduledEmail(id), ['commit-first.txt']);
        claimScheduledEmail(id, new Date('2026-02-01T00:00:00.000Z'));
        const spoolBundle = bundleDirectory(loadQueue()[0].attachments![0]);
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(destination.toString()) === path.resolve(queuePath)) {
                throw new Error('final commit failed');
            }
            renameSync(source, destination);
        });

        expect(() => markScheduledEmailSent(id, 'gmail-id')).toThrow('final commit failed');
        vi.restoreAllMocks();
        expect(fs.existsSync(spoolBundle)).toBe(true);
        expect(loadQueue()[0].status).toBe('sending');
    });

    it('removes a new spool if queue persistence fails', () => {
        writeImport('rollback.txt', 'rollback bytes');
        const renameSync = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (path.resolve(destination.toString()) === path.resolve(queuePath)) {
                throw new Error('simulated attached queue rename failure');
            }
            renameSync(source, destination);
        });

        expect(() => enqueueScheduledEmail(scheduledEmail('rollback-spool'), ['rollback.txt']))
            .toThrow('simulated attached queue rename failure');
        vi.restoreAllMocks();
        expect(fs.readdirSync(getScheduledAttachmentsDirectory(stateDirectory))).toEqual([]);
    });

    it('retains interrupted owned bytes while removing unrelated orphan bundles', () => {
        writeImport('recover.txt', 'recover bytes');
        enqueueScheduledEmail(scheduledEmail('interrupted-with-attachment'), ['recover.txt']);
        claimScheduledEmail('interrupted-with-attachment', new Date('2026-02-01T00:00:00.000Z'));
        spoolScheduledAttachments('orphaned-message', ['recover.txt'], stateDirectory);
        expect(fs.readdirSync(getScheduledAttachmentsDirectory(stateDirectory))).toHaveLength(2);

        const recoveredAt = new Date('2026-02-01T00:01:00.000Z');
        expect(recoverInterruptedScheduledEmails(recoveredAt)).toBe(1);
        const entries = fs.readdirSync(getScheduledAttachmentsDirectory(stateDirectory));
        expect(entries).toHaveLength(1);
        const recovered = loadQueue(recoveredAt)[0];
        expect(recovered).toMatchObject({
            id: 'interrupted-with-attachment',
            status: 'uncertain',
        });
        expect(recovered.attachments).toHaveLength(1);
        expect(loadScheduledAttachments(
            recovered.id,
            recovered.attachments!,
            stateDirectory,
        )[0].content.toString()).toBe('recover bytes');
    });
});

describe('account credential paths', () => {
    it('canonicalizes email addresses and rejects path traversal', () => {
        expect(canonicalizeAccountEmail(' User.Name+tag@Example.COM '))
            .toBe('user.name+tag@example.com');
        expect(getAccountCredentialsPath('User@Example.COM'))
            .toBe(path.join(stateDirectory, 'accounts', 'user@example.com.json'));
        expect(() => getAccountCredentialsPath('../../etc/gmail-mcp/oauth'))
            .toThrow('Invalid Gmail account email address');
        expect(() => getAccountCredentialsPath('user@example.com/../../oauth'))
            .toThrow('Invalid Gmail account email address');
    });
});
