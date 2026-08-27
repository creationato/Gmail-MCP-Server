#!/usr/bin/env node
/**
 * Live test for inline images in HTML emails.
 *
 * Exercises the ACTUAL compiled createEmailWithNodemailer() from dist/, sends real
 * mail through the Gmail API with the MCP's OAuth credential, then re-fetches each
 * sent message and verifies the MIME structure round-trips:
 *   - a multipart/related container is present
 *   - each inline image is an image/* part with Content-ID + Content-Disposition: inline
 *   - the cid matches the <img src="cid:..."> reference in the HTML body
 *
 * Run after `npm run build`:  node test-inline-images.mjs
 *
 * Scenarios:
 *   A. HTML email + one path-based inline image
 *   B. HTML email + one base64 content-based inline image
 *   C. HTML email + one inline image + one regular (non-inline) attachment
 *
 * Test mail is sent from the default send-as alias to jonas+<test-id>@duplo.org
 * (plus-addressing — all copies land in the same mailbox) and left in place,
 * subject-tagged [INLINE-IMG-TEST], so it can be reviewed and bulk-deleted by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { createEmailWithNodemailer } from './dist/utl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.GMAIL_MCP_STATE_DIR || path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const SOURCE_FIXTURE = path.join(__dirname, 'test', 'fixtures', 'inline-test.png');
const MANAGED_IMPORTS = path.join(CONFIG_DIR, 'files', 'imports');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const FROM = 'j@duplo.org';
const recipient = (id) => `jonas+inline-img-${id}-${STAMP}@duplo.org`;

function loadAuth() {
    const keysFile = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
    const keys = keysFile.installed || keysFile.web;
    const credFile = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const tokens = credFile.tokens || credFile;
    const client = new OAuth2Client(keys.client_id, keys.client_secret, 'http://localhost:3000/oauth2callback');
    client.setCredentials(tokens);
    return client;
}

function encodeRaw(message) {
    return Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Flatten a Gmail message payload into a list of every MIME part.
function flattenParts(payload) {
    const out = [];
    (function walk(p) {
        if (!p) return;
        out.push(p);
        (p.parts || []).forEach(walk);
    })(payload);
    return out;
}

function header(part, name) {
    const h = (part.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : null;
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * Send one raw message and re-fetch it; validate the inline-image MIME structure.
 * expectedCids: cids that must appear as inline image parts.
 * expectAttachment: whether a non-inline attachment part must also be present.
 */
async function sendAndValidate(gmail, label, raw, expectedCids, expectAttachment) {
    console.log(`\n[${label}]`);
    const sent = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodeRaw(raw) },
    });
    const id = sent.data.id;
    check(`${label}: message accepted by Gmail`, !!id, `id=${id}`);

    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const parts = flattenParts(msg.data.payload);

    const hasRelated = parts.some((p) => p.mimeType === 'multipart/related');
    check(`${label}: multipart/related container present`, hasRelated);

    const inlineImageParts = parts.filter(
        (p) =>
            (p.mimeType || '').startsWith('image/') &&
            (header(p, 'Content-Disposition') || '').toLowerCase().includes('inline'),
    );
    check(
        `${label}: inline image part count`,
        inlineImageParts.length === expectedCids.length,
        `expected ${expectedCids.length}, got ${inlineImageParts.length}`,
    );

    const foundCids = inlineImageParts.map((p) => (header(p, 'Content-ID') || '').replace(/[<>]/g, ''));
    for (const cid of expectedCids) {
        check(`${label}: inline part has Content-ID <${cid}>`, foundCids.includes(cid));
    }

    // The HTML body must reference each cid.
    const htmlPart = parts.find((p) => p.mimeType === 'text/html');
    const html = htmlPart && htmlPart.body && htmlPart.body.data
        ? Buffer.from(htmlPart.body.data, 'base64').toString('utf8')
        : '';
    for (const cid of expectedCids) {
        check(`${label}: htmlBody references cid:${cid}`, html.includes(`cid:${cid}`));
    }

    if (expectAttachment) {
        const attachmentParts = parts.filter(
            (p) => (header(p, 'Content-Disposition') || '').toLowerCase().includes('attachment'),
        );
        check(`${label}: regular (non-inline) attachment present`, attachmentParts.length >= 1);
        const hasMixed = parts.some((p) => p.mimeType === 'multipart/mixed');
        check(`${label}: multipart/mixed wrapper present`, hasMixed);
    }

    return id;
}

async function main() {
    if (!fs.existsSync(SOURCE_FIXTURE)) {
        console.error(`Missing fixture: ${SOURCE_FIXTURE} — run from the repo root after build.`);
        process.exit(1);
    }
    const harnessDirectory = path.join(MANAGED_IMPORTS, 'inline-live-test');
    fs.mkdirSync(harnessDirectory, { recursive: true, mode: 0o700 });
    const imageName = `inline-${STAMP}.png`;
    const attachmentName = `attachment-${STAMP}.txt`;
    const managedImage = path.join(harnessDirectory, imageName);
    const managedAttachment = path.join(harnessDirectory, attachmentName);
    fs.copyFileSync(SOURCE_FIXTURE, managedImage);
    fs.chmodSync(managedImage, 0o600);
    fs.writeFileSync(managedAttachment, 'Regular attachment alongside an inline image.\n', {
        mode: 0o600,
    });
    const imagePath = `inline-live-test/${imageName}`;
    const attachmentPath = `inline-live-test/${attachmentName}`;
    const gmail = google.gmail({ version: 'v1', auth: loadAuth() });
    const pngBase64 = fs.readFileSync(managedImage).toString('base64');
    const sentIds = [];

    // Scenario A — path-based inline image
    const rawA = await createEmailWithNodemailer({
        from: FROM,
        to: [recipient('a')],
        subject: `[INLINE-IMG-TEST] A — path-based inline image (${STAMP})`,
        body: 'Plain-text fallback: this email embeds one inline image.',
        htmlBody: '<p>Scenario A — path-based inline image:</p><img src="cid:bannerA" alt="banner">',
        inlineImages: [{ cid: 'bannerA', path: imagePath }],
    });
    sentIds.push(await sendAndValidate(gmail, 'A', rawA, ['bannerA'], false));

    // Scenario B — base64 content-based inline image
    const rawB = await createEmailWithNodemailer({
        from: FROM,
        to: [recipient('b')],
        subject: `[INLINE-IMG-TEST] B — base64 content inline image (${STAMP})`,
        body: 'Plain-text fallback: this email embeds one inline image from base64.',
        htmlBody: '<p>Scenario B — base64 content inline image:</p><img src="cid:bannerB" alt="banner">',
        inlineImages: [{ cid: 'bannerB', content: pngBase64, contentType: 'image/png' }],
    });
    sentIds.push(await sendAndValidate(gmail, 'B', rawB, ['bannerB'], false));

    // Scenario C — inline image + regular attachment
    const rawC = await createEmailWithNodemailer({
        from: FROM,
        to: [recipient('c')],
        subject: `[INLINE-IMG-TEST] C — inline image + attachment (${STAMP})`,
        body: 'Plain-text fallback: inline image plus a regular attachment.',
        htmlBody: '<p>Scenario C — inline image with a separate attachment:</p><img src="cid:bannerC" alt="banner">',
        attachments: [attachmentPath],
        inlineImages: [{ cid: 'bannerC', path: imagePath }],
    });
    sentIds.push(await sendAndValidate(gmail, 'C', rawC, ['bannerC'], true));
    fs.rmSync(managedImage, { force: true });
    fs.rmSync(managedAttachment, { force: true });

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`RESULT: ${passed}/${results.length} checks passed, ${failed} failed`);
    console.log(`Sent message IDs: ${sentIds.join(', ')}`);
    console.log(`Recipients (plus-addressed to jonas@duplo.org), subject tag [INLINE-IMG-TEST].`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('\nHARNESS ERROR:', err.message);
    process.exit(1);
});
