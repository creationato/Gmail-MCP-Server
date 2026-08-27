import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-queue-process-test-'));
const dbModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'db.js')).href;
const managedFilesModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'managed-files.js')).href;
const stateLockModuleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'state-lock.js')).href;
const workerEnvironment = { ...process.env, GMAIL_MCP_STATE_DIR: stateDirectory };

function spawnChild(args, options = {}) {
    return spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: workerEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
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
            else reject(new Error(`Queue worker exited ${code ?? signal}: ${stderr || stdout}`));
        });
    });
}

async function runWorker(source) {
    const result = await collectChild(spawnChild(['--input-type=module', '--eval', source]));
    return result.stdout;
}

function waitForOutput(child, marker, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Timed out waiting for ${marker}: ${stderr || stdout}`));
        }, timeoutMs);
        const onStdout = chunk => {
            stdout += chunk.toString();
            if (!stdout.includes(marker)) return;
            clearTimeout(timeout);
            child.stdout.off('data', onStdout);
            resolve();
        };
        child.stdout.on('data', onStdout);
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            reject(new Error(`Worker exited ${code ?? signal} before ${marker}: ${stderr || stdout}`));
        });
    });
}

function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
}

try {
    await Promise.all(Array.from({ length: 8 }, () => runWorker(`
        const { ensureDirectories } = await import(${JSON.stringify(dbModuleUrl)});
        ensureDirectories();
    `)));
    const importDirectory = path.join(stateDirectory, 'files', 'imports');
    fs.writeFileSync(path.join(importDirectory, 'shared.txt'), 'concurrent attachment bytes', { mode: 0o600 });

    const workers = 8;
    const messagesPerWorker = 12;
    await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(`
        const { enqueueScheduledEmail } = await import(${JSON.stringify(dbModuleUrl)});
        for (let index = 0; index < ${messagesPerWorker}; index += 1) {
            const id = ${JSON.stringify(String(worker))} + '-' + index;
            enqueueScheduledEmail({
                id,
                account: 'user@gmail.com',
                to: ['recipient@example.com'],
                subject: id,
                body: 'Body',
                scheduledTime: '2026-01-01T00:00:00.000Z',
                status: 'pending',
                attempts: 0,
            }, ['shared.txt']);
        }
    `)));

    process.env.GMAIL_MCP_STATE_DIR = stateDirectory;
    const {
        claimScheduledEmail,
        enqueueScheduledEmail,
        loadQueue,
        recoverInterruptedScheduledEmails,
    } = await import(dbModuleUrl);
    const {
        getManagedStorageUsage,
        loadScheduledAttachments,
        MAX_MANAGED_EXPORT_BYTES,
        MAX_SCHEDULED_SPOOL_BYTES,
    } = await import(managedFilesModuleUrl);

    const queue = loadQueue();
    assert.equal(queue.length, workers * messagesPerWorker);
    assert.equal(new Set(queue.map(email => email.id)).size, queue.length);
    assert.equal(new Set(queue.map(email => path.dirname(email.attachments[0].relativePath))).size, queue.length);
    fs.unlinkSync(path.join(importDirectory, 'shared.txt'));
    for (const email of queue) {
        const loaded = loadScheduledAttachments(email.id, email.attachments, stateDirectory);
        assert.equal(loaded[0].content.toString(), 'concurrent attachment bytes');
    }

    enqueueScheduledEmail({
        id: 'single-claim',
        account: 'user@gmail.com',
        to: ['recipient@example.com'],
        subject: 'Single claim',
        body: 'Body',
        scheduledTime: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        attempts: 0,
    });
    const claimResults = await Promise.all(Array.from({ length: workers }, () => runWorker(`
        const { claimScheduledEmail } = await import(${JSON.stringify(dbModuleUrl)});
        process.stdout.write(claimScheduledEmail('single-claim', new Date('2026-02-01T00:00:00.000Z')) ? 'claimed' : 'skipped');
    `)));
    assert.equal(claimResults.filter(result => result === 'claimed').length, 1);
    assert.equal(claimScheduledEmail('single-claim', new Date('2026-02-01T00:00:00.000Z')), undefined);
    assert.equal(recoverInterruptedScheduledEmails(), 1);
    assert.equal(loadQueue().find(email => email.id === 'single-claim')?.status, 'uncertain');

    const crashMarker = path.join(stateDirectory, 'state-lock-crash-marker');
    const crashedLockHolder = spawnChild(['--input-type=module', '--eval', `
        const fs = await import('node:fs');
        const { withStateLockSync } = await import(${JSON.stringify(stateLockModuleUrl)});
        withStateLockSync(() => {
            fs.writeFileSync(${JSON.stringify(crashMarker)}, 'locked');
            process.kill(process.pid, 'SIGKILL');
        });
    `]);
    const crashResult = await collectChild(crashedLockHolder, true);
    assert.equal(crashResult.signal, 'SIGKILL');
    assert.equal(fs.readFileSync(crashMarker, 'utf8'), 'locked');
    enqueueScheduledEmail({
        id: 'after-lock-crash',
        account: 'user@gmail.com',
        to: ['recipient@example.com'],
        subject: 'Crash recovery',
        body: 'Body',
        scheduledTime: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        attempts: 0,
    });
    assert.ok(loadQueue().some(email => email.id === 'after-lock-crash'));

    enqueueScheduledEmail({
        id: 'lease-active-send',
        account: 'user@gmail.com',
        to: ['recipient@example.com'],
        subject: 'Lease',
        body: 'Body',
        scheduledTime: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        attempts: 0,
    });
    claimScheduledEmail('lease-active-send', new Date('2026-02-01T00:00:00.000Z'));

    const leaseHolder = spawnChild(['--input-type=module', '--eval', `
        const { acquireSchedulerLease } = await import(${JSON.stringify(dbModuleUrl)});
        acquireSchedulerLease();
        process.stdout.write('LEASED\\n');
        setInterval(() => {}, 60_000);
    `]);
    await waitForOutput(leaseHolder, 'LEASED');

    const secondScheduler = await collectChild(
        spawnChild([path.join('dist', 'index.js'), 'scheduler']),
        true,
    );
    assert.notEqual(secondScheduler.code, 0);
    assert.match(secondScheduler.stderr, /already holds the scheduler lease/);
    assert.equal(loadQueue().find(email => email.id === 'lease-active-send')?.status, 'sending');

    const holderExit = waitForExit(leaseHolder);
    leaseHolder.kill('SIGKILL');
    assert.equal((await holderExit).signal, 'SIGKILL');
    assert.equal(await runWorker(`
        const { acquireSchedulerLease } = await import(${JSON.stringify(dbModuleUrl)});
        const lease = acquireSchedulerLease();
        lease.release();
        process.stdout.write('reacquired');
    `), 'reacquired');

    const exportDirectory = path.join(stateDirectory, 'files', 'exports');
    const exportSeed = path.join(exportDirectory, 'quota-seed.bin');
    fs.writeFileSync(exportSeed, '', { mode: 0o600 });
    fs.truncateSync(exportSeed, MAX_MANAGED_EXPORT_BYTES - 8);
    const exportResults = await Promise.all(['a', 'b'].map(name => runWorker(`
        const { writeManagedExportFile } = await import(${JSON.stringify(managedFilesModuleUrl)});
        try {
            writeManagedExportFile(${JSON.stringify(name)} + '.bin', Buffer.alloc(8));
            process.stdout.write('written');
        } catch (error) {
            if (!/quota/.test(error.message)) throw error;
            process.stdout.write('rejected');
        }
    `)));
    assert.equal(exportResults.filter(result => result === 'written').length, 1);
    assert.equal(exportResults.filter(result => result === 'rejected').length, 1);
    assert.equal(getManagedStorageUsage(stateDirectory).exportBytes, MAX_MANAGED_EXPORT_BYTES);

    fs.writeFileSync(path.join(importDirectory, 'quota.txt'), '12345678', { mode: 0o600 });
    const spoolDirectory = path.join(stateDirectory, 'scheduled-attachments');
    const currentSpoolUsage = getManagedStorageUsage(stateDirectory).scheduledSpoolBytes;
    const spoolSeed = path.join(spoolDirectory, 'quota-seed.bin');
    fs.writeFileSync(spoolSeed, '', { mode: 0o600 });
    fs.truncateSync(spoolSeed, MAX_SCHEDULED_SPOOL_BYTES - currentSpoolUsage - 8);
    const spoolResults = await Promise.all(['quota-a', 'quota-b'].map(id => runWorker(`
        const { spoolScheduledAttachments } = await import(${JSON.stringify(managedFilesModuleUrl)});
        try {
            spoolScheduledAttachments(${JSON.stringify(id)}, ['quota.txt']);
            process.stdout.write('spooled');
        } catch (error) {
            if (!/quota/.test(error.message)) throw error;
            process.stdout.write('rejected');
        }
    `)));
    assert.equal(spoolResults.filter(result => result === 'spooled').length, 1);
    assert.equal(spoolResults.filter(result => result === 'rejected').length, 1);
    assert.equal(getManagedStorageUsage(stateDirectory).scheduledSpoolBytes, MAX_SCHEDULED_SPOOL_BYTES);

    console.log('Concurrent queue, quota, crash, and scheduler lease process tests passed.');
} finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
}
