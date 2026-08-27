import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ensureManagedFileDirectories,
    getManagedExportDirectory,
    getManagedImportDirectory,
    getManagedStorageUsage,
    getScheduledAttachmentsDirectory,
    loadManagedAttachment,
    loadManagedAttachments,
    loadScheduledAttachments,
    MAX_ATTACHMENT_AGGREGATE_BYTES,
    MAX_ATTACHMENT_COUNT,
    MAX_ATTACHMENT_FILE_BYTES,
    MAX_MANAGED_EXPORT_BYTES,
    MAX_SCHEDULED_SPOOL_BYTES,
    removeScheduledAttachments,
    spoolScheduledAttachments,
    validateManagedExportFilename,
    writeManagedExportFile,
} from './managed-files.js';
import { createEmailWithNodemailer } from './utl.js';

let stateDirectory: string;
let previousStateDirectory: string | undefined;

beforeEach(() => {
    previousStateDirectory = process.env.GMAIL_MCP_STATE_DIR;
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-managed-files-test-'));
    process.env.GMAIL_MCP_STATE_DIR = stateDirectory;
    ensureManagedFileDirectories(stateDirectory);
});

afterEach(() => {
    if (previousStateDirectory === undefined) delete process.env.GMAIL_MCP_STATE_DIR;
    else process.env.GMAIL_MCP_STATE_DIR = previousStateDirectory;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
});

function writeImport(name: string, contents: string): string {
    const filePath = path.join(getManagedImportDirectory(stateDirectory), name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    return filePath;
}

describe('managed attachment reads', () => {
    it('supports relative imports and absolute paths returned from managed exports', async () => {
        const importPath = writeImport('quarterly-report.txt', 'managed import contents');
        const exported = writeManagedExportFile(
            'downloaded.txt',
            'managed export contents',
            undefined,
            stateDirectory,
        );

        expect(loadManagedAttachment('quarterly-report.txt', stateDirectory)).toEqual({
            filename: 'quarterly-report.txt',
            content: Buffer.from('managed import contents'),
        });
        expect(loadManagedAttachment(importPath, stateDirectory).content.toString()).toBe(
            'managed import contents',
        );
        expect(loadManagedAttachment(exported.path, stateDirectory).content.toString()).toBe(
            'managed export contents',
        );

        const message = await createEmailWithNodemailer({
            to: ['recipient@example.com'],
            subject: 'Managed attachment',
            body: 'Body',
            attachments: ['quarterly-report.txt'],
        });
        expect(message).toContain('filename=quarterly-report.txt');
        expect(message).toContain(Buffer.from('managed import contents').toString('base64'));
    });

    it('rejects traversal and protected credential or state files', () => {
        const credentials = path.join(stateDirectory, 'credentials.json');
        const database = path.join(stateDirectory, 'state.sqlite3');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        fs.writeFileSync(database, 'sqlite-secret', { mode: 0o600 });

        for (const candidate of [
            '../credentials.json',
            '../../etc/passwd',
            credentials,
            database,
            '/proc/self/environ',
        ]) {
            expect(() => loadManagedAttachment(candidate, stateDirectory)).toThrow();
        }
    });

    it('rejects symlinks, symlinked parent directories, and non-regular files', () => {
        const imports = getManagedImportDirectory(stateDirectory);
        const protectedFile = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(protectedFile, 'do-not-read', { mode: 0o600 });
        fs.symlinkSync(protectedFile, path.join(imports, 'credential-link'));

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-managed-outside-'));
        fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
        fs.symlinkSync(outside, path.join(imports, 'linked-directory'));
        fs.mkdirSync(path.join(imports, 'not-a-file'));

        expect(() => loadManagedAttachment('credential-link', stateDirectory)).toThrow(/regular file|plain/);
        expect(() => loadManagedAttachment('linked-directory/outside.txt', stateDirectory)).toThrow(/symlink/);
        expect(() => loadManagedAttachment('not-a-file', stateDirectory)).toThrow(/regular file/);

        const fifo = path.join(imports, 'named-pipe');
        try {
            execFileSync('mkfifo', [fifo]);
            expect(() => loadManagedAttachment('named-pipe', stateDirectory)).toThrow(/regular file/);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('enforces count, per-file, aggregate, and canonical duplicate limits before reading bytes', () => {
        expect(() => loadManagedAttachments(
            Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) => `${index}.txt`),
            stateDirectory,
        )).toThrow(`At most ${MAX_ATTACHMENT_COUNT}`);

        const duplicate = writeImport('duplicate.txt', 'one copy');
        expect(() => loadManagedAttachments(
            ['duplicate.txt', './duplicate.txt'],
            stateDirectory,
        )).toThrow(/Duplicate attachment paths/);
        expect(() => loadManagedAttachments(
            ['duplicate.txt', duplicate],
            stateDirectory,
        )).toThrow(/Duplicate attachment paths/);

        const oversized = writeImport('oversized.bin', '');
        fs.truncateSync(oversized, MAX_ATTACHMENT_FILE_BYTES + 1);
        expect(() => loadManagedAttachment('oversized.bin', stateDirectory)).toThrow(/per-file limit/);

        const first = writeImport('aggregate-a.bin', '');
        const second = writeImport('aggregate-b.bin', '');
        fs.truncateSync(first, Math.floor(MAX_ATTACHMENT_AGGREGATE_BYTES / 2) + 1);
        fs.truncateSync(second, Math.ceil(MAX_ATTACHMENT_AGGREGATE_BYTES / 2));
        expect(() => loadManagedAttachments(
            ['aggregate-a.bin', 'aggregate-b.bin'],
            stateDirectory,
        )).toThrow(/Aggregate attachments/);
    });

    it('rejects hardlinked imports, including a hardlink to credentials', () => {
        const credentials = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        fs.linkSync(credentials, path.join(getManagedImportDirectory(stateDirectory), 'credentials-copy'));

        expect(() => loadManagedAttachment('credentials-copy', stateDirectory)).toThrow(/multiply linked/);
    });
});

describe('managed exports', () => {
    it('uses the export root by default, supports safe subdirectories, and never overwrites', () => {
        const first = writeManagedExportFile('message.eml', 'first', undefined, stateDirectory);
        const second = writeManagedExportFile('message.eml', 'second', 'archive/2026', stateDirectory);
        const collision = writeManagedExportFile('message.eml', 'third', undefined, stateDirectory);

        expect(first.path).toBe(path.join(getManagedExportDirectory(stateDirectory), 'message.eml'));
        expect(second.path).toBe(
            path.join(getManagedExportDirectory(stateDirectory), 'archive', '2026', 'message.eml'),
        );
        expect(collision.path).not.toBe(first.path);
        expect(fs.readFileSync(first.path, 'utf8')).toBe('first');
        expect(fs.readFileSync(collision.path, 'utf8')).toBe('third');
        expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
    });

    it('cannot traverse to or overwrite credential and state files', () => {
        const credentials = path.join(stateDirectory, 'credentials.json');
        const database = path.join(stateDirectory, 'state.sqlite3');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        fs.writeFileSync(database, 'sqlite-secret', { mode: 0o600 });

        expect(() => writeManagedExportFile('message.txt', 'bad', '..', stateDirectory)).toThrow(/traversal/);
        expect(() => writeManagedExportFile('message.txt', 'bad', stateDirectory, stateDirectory)).toThrow(
            /must stay within/,
        );
        expect(() => writeManagedExportFile('../credentials.json', 'bad', undefined, stateDirectory)).toThrow(
            /single plain filename/,
        );
        expect(() => validateManagedExportFilename('../../state.sqlite3')).toThrow(/single plain filename/);
        expect(fs.readFileSync(credentials, 'utf8')).toBe('oauth-secret');
        expect(fs.readFileSync(database, 'utf8')).toBe('sqlite-secret');
    });

    it('rejects symlinked directories and symlink or special-file destinations', () => {
        const exports = getManagedExportDirectory(stateDirectory);
        const protectedFile = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(protectedFile, 'oauth-secret', { mode: 0o600 });

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-export-outside-'));
        fs.symlinkSync(outside, path.join(exports, 'escape'));
        expect(() => writeManagedExportFile('message.txt', 'bad', 'escape', stateDirectory)).toThrow(/symlink/);
        fs.unlinkSync(path.join(exports, 'escape'));

        fs.symlinkSync(protectedFile, path.join(exports, 'credential-link'));
        expect(() => writeManagedExportFile('credential-link', 'bad', undefined, stateDirectory))
            .toThrow(/symlink/);
        fs.unlinkSync(path.join(exports, 'credential-link'));

        fs.mkdirSync(path.join(exports, 'directory-destination'));
        expect(() => writeManagedExportFile('directory-destination', 'bad', undefined, stateDirectory)).toThrow(
            /symlink or special/,
        );
        expect(fs.readFileSync(protectedFile, 'utf8')).toBe('oauth-secret');
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('allows the exact aggregate export quota and rejects the next byte', () => {
        const existing = path.join(getManagedExportDirectory(stateDirectory), 'existing.bin');
        fs.writeFileSync(existing, '', { mode: 0o600 });
        fs.truncateSync(existing, MAX_MANAGED_EXPORT_BYTES - 4);

        writeManagedExportFile('boundary.bin', Buffer.alloc(4), undefined, stateDirectory);
        expect(getManagedStorageUsage(stateDirectory).exportBytes).toBe(MAX_MANAGED_EXPORT_BYTES);
        expect(() => writeManagedExportFile('overflow.bin', 'x', undefined, stateDirectory))
            .toThrow(/export quota/);
    });
});

describe('scheduled attachment spooling', () => {
    it('persists inferred, byte-verified inline MIME metadata', () => {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
            'base64',
        );
        const imagePath = path.join(getManagedImportDirectory(stateDirectory), 'scheduled.png');
        fs.writeFileSync(imagePath, png, { mode: 0o600 });

        const descriptors = spoolScheduledAttachments(
            'inline-metadata',
            [],
            stateDirectory,
            [{ cid: 'logo', path: 'scheduled.png' }],
        );
        expect(descriptors[0]).toMatchObject({ cid: 'logo', contentType: 'image/png' });
        expect(loadScheduledAttachments('inline-metadata', descriptors, stateDirectory)[0])
            .toMatchObject({ cid: 'logo', contentType: 'image/png', content: png });
    });

    it('survives moving the complete state tree to a different VM path', () => {
        writeImport('portable.txt', 'bytes survive migration');
        const descriptors = spoolScheduledAttachments(
            'portable-message',
            ['portable.txt'],
            stateDirectory,
        );
        expect(path.isAbsolute(descriptors[0].relativePath)).toBe(false);
        expect(descriptors[0].relativePath).not.toContain(stateDirectory);
        fs.writeFileSync(
            path.join(stateDirectory, 'scheduled_queue.json'),
            JSON.stringify([{ id: 'portable-message', attachments: descriptors }]),
            { mode: 0o600 },
        );

        const migratedState = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-managed-migrated-'));
        fs.cpSync(stateDirectory, migratedState, { recursive: true });
        fs.rmSync(stateDirectory, { recursive: true, force: true });

        try {
            const migratedQueue = JSON.parse(
                fs.readFileSync(path.join(migratedState, 'scheduled_queue.json'), 'utf8'),
            ) as Array<{ attachments: typeof descriptors }>;
            expect(JSON.stringify(migratedQueue)).not.toContain(stateDirectory);
            const loaded = loadScheduledAttachments(
                'portable-message',
                migratedQueue[0].attachments,
                migratedState,
            );
            expect(loaded).toEqual([
                { filename: 'portable.txt', content: Buffer.from('bytes survive migration') },
            ]);
        } finally {
            fs.rmSync(migratedState, { recursive: true, force: true });
        }
    });

    it('detects spool corruption and removes only its owned bundle', () => {
        writeImport('one.txt', 'first attachment');
        writeImport('two.txt', 'second attachment');
        const first = spoolScheduledAttachments('first-message', ['one.txt'], stateDirectory);
        const second = spoolScheduledAttachments('second-message', ['two.txt'], stateDirectory);
        const firstPath = path.join(stateDirectory, ...first[0].relativePath.split('/'));
        const firstBundle = path.dirname(firstPath);
        const secondBundle = path.dirname(
            path.join(stateDirectory, ...second[0].relativePath.split('/')),
        );

        fs.writeFileSync(firstPath, 'tampered');
        expect(() => loadScheduledAttachments('first-message', first, stateDirectory)).toThrow(/integrity/);
        removeScheduledAttachments('first-message', first, stateDirectory);
        expect(fs.existsSync(firstBundle)).toBe(false);
        expect(fs.existsSync(secondBundle)).toBe(true);
        expect(fs.readdirSync(getScheduledAttachmentsDirectory(stateDirectory))).toHaveLength(1);
    });

    it('rejects a symlink substituted for a spooled file', () => {
        writeImport('safe.txt', 'safe');
        const descriptors = spoolScheduledAttachments('symlink-message', ['safe.txt'], stateDirectory);
        const spoolPath = path.join(stateDirectory, ...descriptors[0].relativePath.split('/'));
        const protectedFile = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(protectedFile, 'oauth-secret', { mode: 0o600 });
        fs.unlinkSync(spoolPath);
        fs.symlinkSync(protectedFile, spoolPath);

        expect(() => loadScheduledAttachments('symlink-message', descriptors, stateDirectory))
            .toThrow(/regular file|plain/);
    });

    it('rejects a hardlink substituted for a spooled file', () => {
        writeImport('safe.txt', 'safe');
        const descriptors = spoolScheduledAttachments('hardlink-message', ['safe.txt'], stateDirectory);
        const spoolPath = path.join(stateDirectory, ...descriptors[0].relativePath.split('/'));
        const credentials = path.join(stateDirectory, 'credentials.json');
        fs.writeFileSync(credentials, 'oauth-secret', { mode: 0o600 });
        fs.unlinkSync(spoolPath);
        fs.linkSync(credentials, spoolPath);

        expect(() => loadScheduledAttachments('hardlink-message', descriptors, stateDirectory))
            .toThrow(/multiply linked/);
    });

    it('binds load and cleanup to the owning schedule ID', () => {
        writeImport('first.txt', 'first');
        writeImport('second.txt', 'second');
        const first = spoolScheduledAttachments('owner-first', ['first.txt'], stateDirectory);
        const second = spoolScheduledAttachments('owner-second', ['second.txt'], stateDirectory);
        const secondBundle = path.dirname(
            path.join(stateDirectory, ...second[0].relativePath.split('/')),
        );

        expect(() => loadScheduledAttachments('owner-first', second, stateDirectory))
            .toThrow(/does not belong/);
        expect(() => removeScheduledAttachments('owner-first', second, stateDirectory))
            .toThrow(/does not belong/);
        expect(fs.existsSync(secondBundle)).toBe(true);
        expect(loadScheduledAttachments('owner-first', first, stateDirectory)[0].content.toString())
            .toBe('first');
    });

    it('allows the exact spool quota and rejects additional scheduled bytes', () => {
        const existing = path.join(getScheduledAttachmentsDirectory(stateDirectory), 'existing.bin');
        fs.writeFileSync(existing, '', { mode: 0o600 });
        fs.truncateSync(existing, MAX_SCHEDULED_SPOOL_BYTES - 4);
        writeImport('boundary.txt', '1234');
        writeImport('overflow.txt', 'x');

        const descriptors = spoolScheduledAttachments(
            'spool-boundary',
            ['boundary.txt'],
            stateDirectory,
        );
        expect(descriptors[0].size).toBe(4);
        expect(getManagedStorageUsage(stateDirectory).scheduledSpoolBytes)
            .toBe(MAX_SCHEDULED_SPOOL_BYTES);
        expect(() => spoolScheduledAttachments(
            'spool-overflow',
            ['overflow.txt'],
            stateDirectory,
        )).toThrow(/attachment quota/);
    });
});
