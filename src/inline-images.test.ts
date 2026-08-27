import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    detectInlineImageContentType,
    ensureManagedFileDirectories,
    getManagedImportDirectory,
    MAX_INLINE_IMAGE_CONTENT_BYTES,
    prepareEmailMimeParts,
} from './managed-files.js';
import {
    InlineImageSchema,
    ReplyAllSchema,
    ScheduleEmailSchema,
    SendEmailSchema,
    UpdateDraftSchema,
} from './tools.js';
import { createEmailWithNodemailer, needsRawBuilder } from './utl.js';

const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
let stateDirectory: string;
let previousStateDirectory: string | undefined;

beforeEach(() => {
    previousStateDirectory = process.env.GMAIL_MCP_STATE_DIR;
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-inline-image-test-'));
    process.env.GMAIL_MCP_STATE_DIR = stateDirectory;
    ensureManagedFileDirectories(stateDirectory);
    fs.writeFileSync(
        path.join(getManagedImportDirectory(stateDirectory), 'pixel.png'),
        Buffer.from(PNG_B64, 'base64'),
        { mode: 0o600 },
    );
});

afterEach(() => {
    if (previousStateDirectory === undefined) delete process.env.GMAIL_MCP_STATE_DIR;
    else process.env.GMAIL_MCP_STATE_DIR = previousStateDirectory;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
});

const baseArgs = {
    to: ['recipient@example.com'],
    subject: 'Inline image test',
    body: 'Plain-text fallback',
    htmlBody: '<p>Look:</p><img src="cid:logo1">',
};

describe('secure inline image MIME generation', () => {
    it('embeds managed path and canonical base64 sources as prepared buffers', async () => {
        const pathRaw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1', path: 'pixel.png', contentType: 'image/png' }],
        });
        expect(pathRaw).toMatch(/Content-Type: multipart\/related/i);
        expect(pathRaw).toMatch(/Content-ID: <logo1>/i);
        expect(pathRaw).toMatch(/Content-Disposition: inline/i);
        expect(pathRaw).toMatch(/multipart\/alternative/i);

        const contentRaw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{
                cid: 'logo1',
                content: PNG_B64,
                contentType: 'image/png',
                filename: 'pixel.png',
            }],
        });
        expect(contentRaw).toMatch(/Content-ID: <logo1>/i);
        expect(contentRaw.replace(/\r?\n/g, '')).toContain(PNG_B64);
    });

    it('supports a regular attachment and the same managed file as a distinct inline MIME part', async () => {
        const parts = prepareEmailMimeParts(
            ['pixel.png'],
            [{ cid: 'logo1', path: 'pixel.png', contentType: 'image/png' }],
            stateDirectory,
        );
        expect(parts).toHaveLength(2);
        expect(parts.every(part => Buffer.isBuffer(part.content))).toBe(true);
        expect(parts[0].cid).toBeUndefined();
        expect(parts[1]).toMatchObject({ cid: 'logo1', contentType: 'image/png' });

        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            attachments: ['pixel.png'],
            inlineImages: [{ cid: 'logo1', path: 'pixel.png', contentType: 'image/png' }],
        });
        expect(raw).toMatch(/multipart\/mixed/i);
        expect(raw).toMatch(/multipart\/related/i);
    });

    it('infers MIME from managed path bytes and rejects explicit path mismatches', () => {
        const [inferred] = prepareEmailMimeParts(
            [],
            [{ cid: 'inferred', path: 'pixel.png' }],
            stateDirectory,
        );
        expect(inferred.contentType).toBe('image/png');
        expect(() => prepareEmailMimeParts(
            [],
            [{ cid: 'mismatch', path: 'pixel.png', contentType: 'image/jpeg' }],
            stateDirectory,
        )).toThrow(/does not match detected image\/png/);
    });

    it('rejects base64 MIME mismatches, SVG, plain text, and truncated signatures', () => {
        expect(() => prepareEmailMimeParts([], [{
            cid: 'mismatch', content: PNG_B64, contentType: 'image/jpeg',
        }], stateDirectory)).toThrow(/does not match detected image\/png/);

        for (const [cid, content] of [
            ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
            ['text', Buffer.from('not an image')],
            ['truncated', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ] as const) {
            expect(() => prepareEmailMimeParts([], [{
                cid, content: content.toString('base64'), contentType: 'image/png',
            }], stateDirectory)).toThrow(/not a supported, well-formed bitmap image/);
        }
    });

    it('rejects unsupported managed files regardless of extension or supplied MIME', () => {
        const imports = getManagedImportDirectory(stateDirectory);
        fs.writeFileSync(path.join(imports, 'active.svg'), '<svg><script>alert(1)</script></svg>');
        fs.writeFileSync(path.join(imports, 'disguised.png'), 'plain text with a png extension');

        expect(() => prepareEmailMimeParts(
            [],
            [{ cid: 'svg-path', path: 'active.svg' }],
            stateDirectory,
        )).toThrow(/not a supported, well-formed bitmap image/);
        expect(() => prepareEmailMimeParts(
            [],
            [{ cid: 'text-path', path: 'disguised.png', contentType: 'image/png' }],
            stateDirectory,
        )).toThrow(/not a supported, well-formed bitmap image/);
    });

    it('detects every supported bitmap container from bytes', () => {
        const png = Buffer.from(PNG_B64, 'base64');
        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
        const jpeg = Buffer.from([
            0xff, 0xd8,
            0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
            0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
            0x00, 0xff, 0xd9,
        ]);
        const webp = Buffer.alloc(30);
        webp.write('RIFF', 0, 'ascii');
        webp.writeUInt32LE(22, 4);
        webp.write('WEBPVP8 ', 8, 'ascii');
        webp.writeUInt32LE(10, 16);
        Buffer.from([0x9d, 0x01, 0x2a]).copy(webp, 23);
        webp.writeUInt16LE(1, 26);
        webp.writeUInt16LE(1, 28);
        const bmp = Buffer.alloc(54);
        bmp.write('BM', 0, 'ascii');
        bmp.writeUInt32LE(bmp.length, 2);
        bmp.writeUInt32LE(54, 10);
        bmp.writeUInt32LE(40, 14);
        bmp.writeInt32LE(1, 18);
        bmp.writeInt32LE(1, 22);
        const ico = Buffer.alloc(22 + png.length);
        ico.writeUInt16LE(1, 2);
        ico.writeUInt16LE(1, 4);
        ico[6] = 1;
        ico[7] = 1;
        ico.writeUInt32LE(png.length, 14);
        ico.writeUInt32LE(22, 18);
        png.copy(ico, 22);

        expect([
            detectInlineImageContentType(png),
            detectInlineImageContentType(jpeg),
            detectInlineImageContentType(gif),
            detectInlineImageContentType(webp),
            detectInlineImageContentType(bmp),
            detectInlineImageContentType(ico),
        ]).toEqual([
            'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon',
        ]);
    });

    it('rejects outside-root paths, symlinks, hardlinks, and unsafe cids', async () => {
        const imports = getManagedImportDirectory(stateDirectory);
        const outside = path.join(stateDirectory, 'secret.png');
        fs.writeFileSync(outside, 'secret', { mode: 0o600 });
        fs.symlinkSync(outside, path.join(imports, 'linked.png'));
        fs.linkSync(outside, path.join(imports, 'hardlinked.png'));

        for (const image of [
            { cid: 'outside', path: outside },
            { cid: 'linked', path: 'linked.png' },
            { cid: 'hardlinked', path: 'hardlinked.png' },
            { cid: 'bad\r\nX-Injected:evil', path: 'pixel.png' },
        ]) {
            await expect(createEmailWithNodemailer({ ...baseArgs, inlineImages: [image] }))
                .rejects.toThrow();
        }
    });

    it.each(['AAAA\n', 'AAA', 'A===', '!!!!', 'AB=='])(
        'rejects malformed or non-canonical base64 %j',
        async content => {
            await expect(createEmailWithNodemailer({
                ...baseArgs,
                inlineImages: [{ cid: 'bad', content, contentType: 'image/png' }],
            })).rejects.toThrow(/canonical base64/);
        },
    );

    it('enforces per-image, base64 aggregate, total-byte, and combined-part limits', () => {
        const overPerImage = Buffer.alloc(MAX_INLINE_IMAGE_CONTENT_BYTES + 1).toString('base64');
        expect(() => prepareEmailMimeParts([], [{
            cid: 'large',
            content: overPerImage,
            contentType: 'image/png',
        }], stateDirectory)).toThrow(/limit/);

        const sevenMiB = Buffer.alloc(7 * 1024 * 1024).toString('base64');
        expect(() => prepareEmailMimeParts([], [0, 1, 2].map(index => ({
            cid: `aggregate-${index}`,
            content: sevenMiB,
            contentType: 'image/png',
        })), stateDirectory)).toThrow(/aggregate limit/);

        const largePath = path.join(getManagedImportDirectory(stateDirectory), 'large.bin');
        fs.writeFileSync(largePath, Buffer.alloc(20 * 1024 * 1024), { mode: 0o600 });
        const sixMiB = Buffer.alloc(6 * 1024 * 1024).toString('base64');
        expect(() => prepareEmailMimeParts(['large.bin'], [{
            cid: 'combined-bytes',
            content: sixMiB,
            contentType: 'image/png',
        }], stateDirectory)).toThrow(/Aggregate attachments and inline images/);

        expect(() => prepareEmailMimeParts(
            ['pixel.png'],
            Array.from({ length: 10 }, (_, index) => ({
                cid: `part-${index}`,
                content: 'AAAA',
                contentType: 'image/png',
            })),
            stateDirectory,
        )).toThrow(/At most 10 total/);
    });

    it('requires htmlBody and unique cids', async () => {
        await expect(createEmailWithNodemailer({
            to: ['recipient@example.com'],
            subject: 'No HTML',
            body: 'plain',
            inlineImages: [{ cid: 'logo1', path: 'pixel.png' }],
        })).rejects.toThrow(/htmlBody/);
        expect(() => prepareEmailMimeParts([], [
            { cid: 'same', content: 'AAAA', contentType: 'image/png' },
            { cid: 'same', content: 'AAAA', contentType: 'image/png' },
        ], stateDirectory)).toThrow(/Duplicate inline image cid/);
    });
});

describe('inline image schemas and routing', () => {
    it('routes MIME-bearing messages through the raw builder only', () => {
        expect(needsRawBuilder({ to: ['a@b.com'], body: 'x' })).toBe(false);
        expect(needsRawBuilder({ attachments: ['a.pdf'] })).toBe(true);
        expect(needsRawBuilder({ inlineImages: [{ cid: 'x', path: 'a.png' }] })).toBe(true);
        expect(needsRawBuilder({ attachments: [], inlineImages: [] })).toBe(false);
    });

    it('accepts both public inline source forms on send, draft update, reply-all, and schedule schemas', () => {
        expect(SendEmailSchema.parse({
            ...baseArgs,
            inlineImages: [{ cid: 'path', path: 'pixel.png' }],
        }).inlineImages).toHaveLength(1);
        expect(ReplyAllSchema.parse({
            messageId: 'abc123',
            body: 'reply',
            htmlBody: '<img src="cid:data">',
            inlineImages: [{ cid: 'data', content: 'AAAA', contentType: 'image/png' }],
        }).inlineImages).toHaveLength(1);
        expect(UpdateDraftSchema.parse({
            draftId: 'draft-123',
            ...baseArgs,
            inlineImages: [{ cid: 'draft-path', path: 'pixel.png' }],
        }).inlineImages).toHaveLength(1);
        expect(ScheduleEmailSchema.parse({
            ...baseArgs,
            scheduledTime: '+5 minutes',
            inlineImages: [{ cid: 'scheduled', path: 'pixel.png' }],
        }).inlineImages).toHaveLength(1);
    });

    it('rejects invalid source combinations, MIME types, filenames, missing HTML, and combined count', () => {
        expect(() => InlineImageSchema.parse({ cid: 'none' })).toThrow();
        expect(() => InlineImageSchema.parse({
            cid: 'both', path: 'a.png', content: 'AAAA', contentType: 'image/png',
        })).toThrow();
        expect(() => InlineImageSchema.parse({ cid: 'type', content: 'AAAA' })).toThrow();
        expect(() => InlineImageSchema.parse({
            cid: 'svg', content: 'AAAA', contentType: 'image/svg+xml',
        })).toThrow();
        expect(() => InlineImageSchema.parse({ cid: 'file', path: 'a.png', filename: '../bad' }))
            .toThrow();
        expect(() => SendEmailSchema.parse({
            to: ['recipient@example.com'], subject: 'x', body: 'x',
            inlineImages: [{ cid: 'x', path: 'pixel.png' }],
        })).toThrow(/inlineImages require htmlBody/);
        expect(() => UpdateDraftSchema.parse({
            draftId: 'draft-123',
            to: ['recipient@example.com'],
            subject: 'x',
            body: 'x',
            inlineImages: [{ cid: 'x', path: 'pixel.png' }],
        })).toThrow(/inlineImages require htmlBody/);
        expect(() => SendEmailSchema.parse({
            ...baseArgs,
            attachments: ['pixel.png'],
            inlineImages: Array.from({ length: 10 }, (_, index) => ({
                cid: `x-${index}`, content: 'AAAA', contentType: 'image/png',
            })),
        })).toThrow(/At most 10 total/);
    });
});
