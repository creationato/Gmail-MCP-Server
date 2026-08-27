import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureStateDirectory, getStateDirectory } from './state.js';

const STATE_LOCK_DATABASE_NAME = 'runtime-lock.sqlite3';
const SCHEDULER_LEASE_DATABASE_NAME = 'scheduler-lease.sqlite3';
export const STATE_LOCK_BUSY_TIMEOUT_MS = 10_000;
export const SCHEDULER_LEASE_BUSY_TIMEOUT_MS = 250;

const heldStateLocks = new Set<string>();

function openLockDatabase(databasePath: string, busyTimeoutMs: number): DatabaseSync {
    ensureStateDirectory(path.dirname(databasePath));
    const database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA synchronous = FULL;`);
    return database;
}

export function getStateLockDatabasePath(stateDirectory = getStateDirectory()): string {
    return path.join(path.resolve(stateDirectory), STATE_LOCK_DATABASE_NAME);
}

export function getSchedulerLeaseDatabasePath(stateDirectory = getStateDirectory()): string {
    return path.join(path.resolve(stateDirectory), SCHEDULER_LEASE_DATABASE_NAME);
}

export function withStateLockSync<T>(
    operation: () => T,
    stateDirectory = getStateDirectory(),
): T {
    const databasePath = getStateLockDatabasePath(stateDirectory);
    if (heldStateLocks.has(databasePath)) return operation();

    const database = openLockDatabase(databasePath, STATE_LOCK_BUSY_TIMEOUT_MS);
    let transactionStarted = false;
    let committed = false;
    try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        heldStateLocks.add(databasePath);
        const result = operation();
        database.exec('COMMIT');
        committed = true;
        return result;
    } finally {
        heldStateLocks.delete(databasePath);
        if (transactionStarted && !committed) {
            try {
                database.exec('ROLLBACK');
            } catch {
                // The original operation or SQLite error is more useful.
            }
        }
        database.close();
    }
}

export class SchedulerLeaseError extends Error {
    constructor(message = 'Another Gmail MCP scheduler process already holds the scheduler lease.') {
        super(message);
        this.name = 'SchedulerLeaseError';
    }
}

export interface SchedulerLease {
    release(): void;
}

export function acquireSchedulerLease(
    stateDirectory = getStateDirectory(),
): SchedulerLease {
    let database: DatabaseSync | undefined;
    try {
        database = openLockDatabase(
            getSchedulerLeaseDatabasePath(stateDirectory),
            SCHEDULER_LEASE_BUSY_TIMEOUT_MS,
        );
        database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
        database?.close();
        const message = error instanceof Error ? error.message : '';
        if (/busy|locked/i.test(message)) throw new SchedulerLeaseError();
        throw error;
    }

    let released = false;
    return {
        release(): void {
            if (released) return;
            released = true;
            try {
                database!.exec('ROLLBACK');
            } finally {
                database!.close();
            }
        },
    };
}
