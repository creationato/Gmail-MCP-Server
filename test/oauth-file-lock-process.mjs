import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-oauth-lock-process-test-'));
const gmailOAuthModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'gmail-oauth.js')).href;
const oauthStoreModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'oauth-store.js')).href;
const stateLockModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'state-lock.js')).href;
const workerEnvironment = { ...process.env, GMAIL_MCP_STATE_DIR: stateDirectory };

function spawnWorker(source) {
    return spawn(process.execPath, ['--input-type=module', '--eval', source], {
        cwd: process.cwd(),
        env: workerEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function collectChild(child, allowFailure = false) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
            if (allowFailure || code === 0) resolve(result);
            else reject(new Error(`OAuth worker exited ${code ?? signal}: ${stderr || stdout}`));
        });
    });
}

async function runWorker(source) {
    return collectChild(spawnWorker(source));
}

function waitForFile(filePath, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (fs.existsSync(filePath)) return resolve();
            if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${filePath}`));
            setTimeout(poll, 10);
        };
        poll();
    });
}

function allRelativePaths(root) {
    const paths = [];
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            paths.push(path.relative(root, absolute));
            if (entry.isDirectory()) pending.push(absolute);
        }
    }
    return paths;
}

try {
    const credentialsPath = path.join(stateDirectory, 'accounts', 'process@gmail.com.json');
    const holderReady = path.join(stateDirectory, 'holder-ready');
    const holderRelease = path.join(stateDirectory, 'holder-release');
    const holder = spawnWorker(`
        const fs = await import('node:fs');
        const { withStateLockSync } = await import(${JSON.stringify(stateLockModuleUrl)});
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        withStateLockSync(() => {
            fs.writeFileSync(${JSON.stringify(holderReady)}, 'ready');
            const deadline = Date.now() + 10_000;
            while (!fs.existsSync(${JSON.stringify(holderRelease)})) {
                if (Date.now() >= deadline) throw new Error('holder release timed out');
                Atomics.wait(sleeper, 0, 0, 10);
            }
        });
    `);
    await waitForFile(holderReady);

    const blockedWriter = spawnWorker(`
        const { saveCredentialsFile } = await import(${JSON.stringify(gmailOAuthModuleUrl)});
        saveCredentialsFile(${JSON.stringify(credentialsPath)}, {
            tokens: { access_token: 'serialized-writer' },
            scopes: ['gmail.modify'],
        });
    `);
    let writerExited = false;
    blockedWriter.once('exit', () => { writerExited = true; });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(writerExited, false, 'credential writer bypassed the SQLite state lock');
    assert.equal(fs.existsSync(credentialsPath), false);
    fs.writeFileSync(holderRelease, 'release');
    await Promise.all([collectChild(holder), collectChild(blockedWriter)]);
    assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).tokens.access_token, 'serialized-writer');

    const crashMarker = path.join(stateDirectory, 'crash-holder-ready');
    const crashedHolder = spawnWorker(`
        const fs = await import('node:fs');
        const { withStateLockSync } = await import(${JSON.stringify(stateLockModuleUrl)});
        withStateLockSync(() => {
            fs.writeFileSync(${JSON.stringify(crashMarker)}, 'ready');
            process.kill(process.pid, 'SIGKILL');
        });
    `);
    const crashResult = await collectChild(crashedHolder, true);
    assert.equal(crashResult.signal, 'SIGKILL');
    assert.equal(fs.readFileSync(crashMarker, 'utf8'), 'ready');
    await runWorker(`
        const { saveCredentialsFile } = await import(${JSON.stringify(gmailOAuthModuleUrl)});
        saveCredentialsFile(${JSON.stringify(credentialsPath)}, {
            tokens: { access_token: 'after-crash' },
            scopes: ['gmail.send'],
        });
    `);
    assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).tokens.access_token, 'after-crash');

    const oauthDatabasePath = path.join(stateDirectory, 'oauth-process-state.sqlite3');
    const { OAuthStateStore } = await import(oauthStoreModuleUrl);
    new OAuthStateStore(oauthDatabasePath).close();
    const workerCount = 2;
    const statesPerWorker = 12;
    await Promise.all(Array.from({ length: workerCount }, (_, worker) => runWorker(`
        const { createPendingGmailOAuthState } = await import(${JSON.stringify(gmailOAuthModuleUrl)});
        const { OAuthStateStore } = await import(${JSON.stringify(oauthStoreModuleUrl)});
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        for (let index = 0; index < ${statesPerWorker}; index += 1) {
            let completed = false;
            for (let attempt = 0; attempt < 100 && !completed; attempt += 1) {
                let store;
                try {
                    store = new OAuthStateStore(${JSON.stringify(oauthDatabasePath)});
                    createPendingGmailOAuthState({
                        accountEmail: 'worker-${worker}-' + index + '@example.com',
                        scopes: ['gmail.readonly'],
                        redirectUri: 'https://example.test/oauth2callback',
                    }, store);
                    completed = true;
                } catch (error) {
                    if (!/busy|locked/i.test(error.message) || attempt === 99) throw error;
                    Atomics.wait(sleeper, 0, 0, 10);
                } finally {
                    store?.close();
                }
            }
        }
    `)));

    const journalPath = `${oauthDatabasePath}.gmail-callbacks.json`;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.version, 1);
    assert.equal(Object.keys(journal.entries).length, workerCount * statesPerWorker);

    const unsafeArtifacts = allRelativePaths(stateDirectory).filter(name => (
        name.endsWith('.lock') || name.includes('.stale-') || name.endsWith('.tmp')
    ));
    assert.deepEqual(unsafeArtifacts, []);

    console.log('OAuth SQLite file-lock concurrency and crash process tests passed.');
} finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
}
