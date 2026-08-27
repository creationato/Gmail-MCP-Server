import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStateDirectory } from './state.js';
import { withStateLockSync } from './state-lock.js';

const FILES_DIRECTORY_NAME = 'files';
const IMPORTS_DIRECTORY_NAME = 'imports';
const EXPORTS_DIRECTORY_NAME = 'exports';
const SCHEDULED_ATTACHMENTS_DIRECTORY_NAME = 'scheduled-attachments';
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COPY_BUFFER_BYTES = 64 * 1024;

// Gmail rejects messages whose aggregate attachment payload exceeds 25 MiB.
export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_AGGREGATE_BYTES = 25 * 1024 * 1024;
export const MAX_MANAGED_PATH_LENGTH = 1024;

// Managed storage remains intentionally bounded even when callers never clean it manually.
export const MAX_MANAGED_EXPORT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_MANAGED_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_SCHEDULED_SPOOL_BYTES = 256 * 1024 * 1024;

export interface PreparedEmailAttachment {
    filename: string;
    content: Buffer;
}

export interface ScheduledAttachmentMetadata {
    filename: string;
    size: number;
    sha256: string;
}

export interface ScheduledAttachment extends ScheduledAttachmentMetadata {
    ownerId: string;
    bundleId: string;
    relativePath: string;
}

export interface ExportedFile {
    path: string;
    size: number;
}

export interface ManagedStorageUsage {
    exportBytes: number;
    scheduledSpoolBytes: number;
}

interface ManagedRoots {
    stateDirectory: string;
    filesDirectory: string;
    importsDirectory: string;
    exportsDirectory: string;
    scheduledAttachmentsDirectory: string;
}

interface ResolvedAttachment {
    root: string;
    filePath: string;
    filename: string;
}

interface AttachmentSnapshot extends ResolvedAttachment {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
}

export interface ScheduledAttachmentReference {
    ownerId: string;
    attachments: ScheduledAttachment[];
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function assertNoNul(value: string, label: string): void {
    if (value.includes('\0')) throw new Error(`${label} must not contain NUL bytes.`);
}

function pathIsWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function assertPathWithin(root: string, candidate: string, label: string): void {
    if (!pathIsWithin(root, candidate)) throw new Error(`${label} must stay within ${root}.`);
}

function relativeSegments(value: string, label: string): string[] {
    assertNoNul(value, label);
    if (path.isAbsolute(value)) throw new Error(`${label} must be relative.`);
    if (value.includes('\\')) throw new Error(`${label} must not contain backslashes.`);
    const segments = value.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.some(segment => segment === '..')) {
        throw new Error(`${label} must not contain path traversal.`);
    }
    return segments;
}

function ensurePlainDirectory(directory: string, recursive = false): void {
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(directory);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        try {
            fs.mkdirSync(directory, { recursive, mode: 0o700 });
        } catch (mkdirError) {
            if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError;
        }
        stats = fs.lstatSync(directory);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Managed path is not a plain directory: ${directory}`);
    }
}

function ensureManagedRoots(stateDirectory = getStateDirectory()): ManagedRoots {
    const resolvedStateDirectory = path.resolve(stateDirectory);
    ensurePlainDirectory(resolvedStateDirectory, true);
    const filesDirectory = path.join(resolvedStateDirectory, FILES_DIRECTORY_NAME);
    const importsDirectory = path.join(filesDirectory, IMPORTS_DIRECTORY_NAME);
    const exportsDirectory = path.join(filesDirectory, EXPORTS_DIRECTORY_NAME);
    const scheduledAttachmentsDirectory = path.join(
        resolvedStateDirectory,
        SCHEDULED_ATTACHMENTS_DIRECTORY_NAME,
    );
    ensurePlainDirectory(filesDirectory);
    ensurePlainDirectory(importsDirectory);
    ensurePlainDirectory(exportsDirectory);
    ensurePlainDirectory(scheduledAttachmentsDirectory);
    return {
        stateDirectory: resolvedStateDirectory,
        filesDirectory,
        importsDirectory,
        exportsDirectory,
        scheduledAttachmentsDirectory,
    };
}

export function getManagedFilesDirectory(stateDirectory = getStateDirectory()): string {
    return path.join(path.resolve(stateDirectory), FILES_DIRECTORY_NAME);
}

export function getManagedImportDirectory(stateDirectory = getStateDirectory()): string {
    return path.join(getManagedFilesDirectory(stateDirectory), IMPORTS_DIRECTORY_NAME);
}

export function getManagedExportDirectory(stateDirectory = getStateDirectory()): string {
    return path.join(getManagedFilesDirectory(stateDirectory), EXPORTS_DIRECTORY_NAME);
}

export function getScheduledAttachmentsDirectory(stateDirectory = getStateDirectory()): string {
    return path.join(path.resolve(stateDirectory), SCHEDULED_ATTACHMENTS_DIRECTORY_NAME);
}

export function ensureManagedFileDirectories(stateDirectory = getStateDirectory()): void {
    ensureManagedRoots(stateDirectory);
}

function assertPlainDirectoryChain(root: string, directory: string): void {
    const resolvedRoot = path.resolve(root);
    const resolvedDirectory = path.resolve(directory);
    assertPathWithin(resolvedRoot, resolvedDirectory, 'Managed directory');
    const rootStats = fs.lstatSync(resolvedRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new Error(`Managed root is not a plain directory: ${resolvedRoot}`);
    }
    const relative = path.relative(resolvedRoot, resolvedDirectory);
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`Managed path contains a symlink or non-directory component: ${current}`);
        }
    }
    assertPathWithin(
        fs.realpathSync(resolvedRoot),
        fs.realpathSync(resolvedDirectory),
        'Managed directory',
    );
}

function ensurePlainDirectoryChain(root: string, segments: string[]): string {
    let current = root;
    assertPlainDirectoryChain(root, root);
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..' || segment.includes(path.sep)) {
            throw new Error('Managed directory contains an invalid path segment.');
        }
        current = path.join(current, segment);
        try {
            const stats = fs.lstatSync(current);
            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error(`Managed path contains a symlink or non-directory component: ${current}`);
            }
        } catch (error) {
            if (!isNodeError(error, 'ENOENT')) throw error;
            try {
                fs.mkdirSync(current, { mode: 0o700 });
            } catch (mkdirError) {
                if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError;
            }
            const stats = fs.lstatSync(current);
            if (stats.isSymbolicLink() || !stats.isDirectory()) {
                throw new Error(`Managed path contains a symlink or non-directory component: ${current}`);
            }
        }
    }
    assertPlainDirectoryChain(root, current);
    return current;
}

function assertOpenedDescriptorWithin(root: string, descriptor: number, label: string): void {
    const descriptorPath = `/proc/self/fd/${descriptor}`;
    if (!fs.existsSync(descriptorPath)) return;
    assertPathWithin(fs.realpathSync(root), fs.realpathSync(descriptorPath), label);
}

function cleanDisplayFilename(filename: string, fallback: string): string {
    const normalized = filename.replace(/\\/g, '/');
    const leaf = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/[\x00-\x1f\x7f]/g, '_');
    if (!leaf || leaf === '.' || leaf === '..') return fallback;
    return leaf.slice(0, 240);
}

function resolveAttachmentPath(inputPath: string, stateDirectory: string): ResolvedAttachment {
    if (
        typeof inputPath !== 'string' ||
        inputPath.trim() === '' ||
        inputPath.length > MAX_MANAGED_PATH_LENGTH
    ) {
        throw new Error(`Attachment paths must contain 1-${MAX_MANAGED_PATH_LENGTH} characters.`);
    }
    assertNoNul(inputPath, 'Attachment path');
    const roots = ensureManagedRoots(stateDirectory);
    let root: string;
    let filePath: string;

    if (path.isAbsolute(inputPath)) {
        filePath = path.resolve(inputPath);
        const matchingRoot = [roots.importsDirectory, roots.exportsDirectory]
            .find(candidate => pathIsWithin(candidate, filePath) && candidate !== filePath);
        if (!matchingRoot) {
            throw new Error(
                `Attachments must be inside ${roots.importsDirectory} or ${roots.exportsDirectory}.`,
            );
        }
        root = matchingRoot;
    } else {
        const segments = relativeSegments(inputPath, 'Attachment path');
        if (segments.length === 0) throw new Error('Attachment path must name a file.');
        if (segments[0] === IMPORTS_DIRECTORY_NAME || segments[0] === EXPORTS_DIRECTORY_NAME) {
            root = segments[0] === IMPORTS_DIRECTORY_NAME
                ? roots.importsDirectory
                : roots.exportsDirectory;
            filePath = path.join(root, ...segments.slice(1));
        } else {
            root = roots.importsDirectory;
            filePath = path.join(root, ...segments);
        }
    }
    if (filePath === root) throw new Error('Attachment path must name a file.');
    return {
        root,
        filePath: path.resolve(filePath),
        filename: cleanDisplayFilename(path.basename(filePath), 'attachment'),
    };
}

function resolveAttachmentSet(inputPaths: string[], stateDirectory: string): ResolvedAttachment[] {
    if (!Array.isArray(inputPaths) || inputPaths.length > MAX_ATTACHMENT_COUNT) {
        throw new Error(`At most ${MAX_ATTACHMENT_COUNT} attachments are allowed.`);
    }
    const resolved = inputPaths.map(inputPath => resolveAttachmentPath(inputPath, stateDirectory));
    const uniquePaths = new Set(resolved.map(item => item.filePath));
    if (uniquePaths.size !== resolved.length) {
        throw new Error('Duplicate attachment paths are not allowed.');
    }
    return resolved;
}

function openResolvedAttachment(
    attachment: ResolvedAttachment,
    expected?: AttachmentSnapshot,
): { descriptor: number; stats: fs.Stats } {
    assertPlainDirectoryChain(attachment.root, path.dirname(attachment.filePath));
    const pathStats = fs.lstatSync(attachment.filePath);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
        throw new Error(`Managed attachment is not a plain regular file: ${attachment.filePath}`);
    }
    if (pathStats.nlink !== 1) throw new Error('Managed attachments must not be multiply linked.');
    const descriptor = fs.openSync(
        attachment.filePath,
        fs.constants.O_RDONLY |
            (fs.constants.O_NOFOLLOW ?? 0) |
            (fs.constants.O_NONBLOCK ?? 0),
    );
    try {
        const stats = fs.fstatSync(descriptor);
        if (!stats.isFile()) throw new Error('Managed attachment is not a regular file.');
        if (stats.nlink !== 1) throw new Error('Managed attachments must not be multiply linked.');
        if (stats.size > MAX_ATTACHMENT_FILE_BYTES) {
            throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_FILE_BYTES}-byte per-file limit.`);
        }
        assertOpenedDescriptorWithin(attachment.root, descriptor, 'Opened managed file');
        if (
            expected &&
            (stats.dev !== expected.dev ||
                stats.ino !== expected.ino ||
                stats.size !== expected.size ||
                stats.mtimeMs !== expected.mtimeMs)
        ) {
            throw new Error('Managed attachment changed after validation.');
        }
        return { descriptor, stats };
    } catch (error) {
        fs.closeSync(descriptor);
        throw error;
    }
}

function assertStableSnapshot(before: fs.Stats, after: fs.Stats): void {
    if (
        after.nlink !== 1 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
    ) {
        throw new Error('Managed attachment changed while it was being read.');
    }
}

function inspectAttachmentSet(inputPaths: string[], stateDirectory: string): AttachmentSnapshot[] {
    const resolved = resolveAttachmentSet(inputPaths, stateDirectory);
    const snapshots: AttachmentSnapshot[] = [];
    const identities = new Set<string>();
    let aggregateBytes = 0;
    for (const attachment of resolved) {
        const opened = openResolvedAttachment(attachment);
        try {
            const identity = `${opened.stats.dev}:${opened.stats.ino}`;
            if (identities.has(identity)) throw new Error('Duplicate attachment files are not allowed.');
            identities.add(identity);
            aggregateBytes += opened.stats.size;
            if (aggregateBytes > MAX_ATTACHMENT_AGGREGATE_BYTES) {
                throw new Error(
                    `Aggregate attachments exceed the ${MAX_ATTACHMENT_AGGREGATE_BYTES}-byte limit.`,
                );
            }
            snapshots.push({
                ...attachment,
                dev: opened.stats.dev,
                ino: opened.stats.ino,
                size: opened.stats.size,
                mtimeMs: opened.stats.mtimeMs,
            });
        } finally {
            fs.closeSync(opened.descriptor);
        }
    }
    return snapshots;
}

function readSnapshot(snapshot: AttachmentSnapshot): Buffer {
    const opened = openResolvedAttachment(snapshot, snapshot);
    try {
        const contents = Buffer.alloc(opened.stats.size);
        let offset = 0;
        while (offset < contents.length) {
            const read = fs.readSync(opened.descriptor, contents, offset, contents.length - offset, null);
            if (read === 0) break;
            offset += read;
        }
        const overflowBytes = fs.readSync(opened.descriptor, Buffer.alloc(1), 0, 1, null);
        assertStableSnapshot(opened.stats, fs.fstatSync(opened.descriptor));
        if (offset !== contents.length || overflowBytes !== 0) {
            throw new Error('Managed attachment changed while it was being read.');
        }
        return contents;
    } finally {
        fs.closeSync(opened.descriptor);
    }
}

export function loadManagedAttachment(
    inputPath: string,
    stateDirectory = getStateDirectory(),
): PreparedEmailAttachment {
    const [snapshot] = inspectAttachmentSet([inputPath], stateDirectory);
    return { filename: snapshot.filename, content: readSnapshot(snapshot) };
}

export function loadManagedAttachments(
    inputPaths: string[],
    stateDirectory = getStateDirectory(),
): PreparedEmailAttachment[] {
    return inspectAttachmentSet(inputPaths, stateDirectory).map(snapshot => ({
        filename: snapshot.filename,
        content: readSnapshot(snapshot),
    }));
}

function resolveExportDirectory(savePath: string | undefined, stateDirectory: string): string {
    const roots = ensureManagedRoots(stateDirectory);
    if (!savePath || savePath.trim() === '' || savePath === '.') return roots.exportsDirectory;
    if (savePath.length > MAX_MANAGED_PATH_LENGTH) throw new Error('Export directory path is too long.');
    assertNoNul(savePath, 'Export directory');
    let segments: string[];
    if (path.isAbsolute(savePath)) {
        const resolved = path.resolve(savePath);
        assertPathWithin(roots.exportsDirectory, resolved, 'Export directory');
        segments = path.relative(roots.exportsDirectory, resolved).split(path.sep).filter(Boolean);
    } else {
        segments = relativeSegments(savePath, 'Export directory');
        if (segments[0] === EXPORTS_DIRECTORY_NAME) segments = segments.slice(1);
    }
    return ensurePlainDirectoryChain(roots.exportsDirectory, segments);
}

function validateOutputFilename(filename: string): string {
    if (typeof filename !== 'string' || filename.trim() === '' || filename.length > 240) {
        throw new Error('Export filename must contain 1-240 characters.');
    }
    assertNoNul(filename, 'Export filename');
    if (
        filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(filename)
    ) {
        throw new Error('Export filename must be a single plain filename without traversal or control characters.');
    }
    return filename;
}

export function validateManagedExportFilename(filename: string): string {
    return validateOutputFilename(filename);
}

function filenameWithCollisionSuffix(filename: string, suffix: string): string {
    const extension = path.extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    return `${stem.slice(0, Math.max(1, 220 - suffix.length))}-${suffix}${extension}`;
}

function syncDirectory(directory: string): void {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function directoryRegularFileBytes(root: string): number {
    let total = 0;
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const name of fs.readdirSync(current)) {
            const candidate = path.join(current, name);
            const stats = fs.lstatSync(candidate);
            if (stats.isSymbolicLink()) throw new Error(`Managed storage contains a symlink: ${candidate}`);
            if (stats.isDirectory()) {
                pending.push(candidate);
                continue;
            }
            if (!stats.isFile()) throw new Error(`Managed storage contains a special file: ${candidate}`);
            if (stats.nlink !== 1) throw new Error('Managed storage files must not be multiply linked.');
            total += stats.size;
        }
    }
    return total;
}

export function getManagedStorageUsage(stateDirectory = getStateDirectory()): ManagedStorageUsage {
    return withStateLockSync(() => {
        const roots = ensureManagedRoots(stateDirectory);
        return {
            exportBytes: directoryRegularFileBytes(roots.exportsDirectory),
            scheduledSpoolBytes: directoryRegularFileBytes(roots.scheduledAttachmentsDirectory),
        };
    }, stateDirectory);
}

export function writeManagedExportFile(
    filename: string,
    contents: string | Uint8Array,
    savePath?: string,
    stateDirectory = getStateDirectory(),
): ExportedFile {
    return withStateLockSync(() => {
        const safeFilename = validateOutputFilename(filename);
        const byteLength = typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength;
        if (byteLength > MAX_MANAGED_EXPORT_FILE_BYTES) {
            throw new Error(`Export exceeds the ${MAX_MANAGED_EXPORT_FILE_BYTES}-byte per-file limit.`);
        }
        const roots = ensureManagedRoots(stateDirectory);
        const currentUsage = directoryRegularFileBytes(roots.exportsDirectory);
        if (currentUsage + byteLength > MAX_MANAGED_EXPORT_BYTES) {
            throw new Error(`Managed export quota of ${MAX_MANAGED_EXPORT_BYTES} bytes would be exceeded.`);
        }
        const directory = resolveExportDirectory(savePath, stateDirectory);
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const candidateName = attempt === 0
                ? safeFilename
                : filenameWithCollisionSuffix(safeFilename, `${attempt}-${randomUUID().slice(0, 8)}`);
            const candidate = path.join(directory, candidateName);
            try {
                const existing = fs.lstatSync(candidate);
                if (existing.isSymbolicLink() || !existing.isFile()) {
                    throw new Error(`Export destination is a symlink or special file: ${candidate}`);
                }
                continue;
            } catch (error) {
                if (!isNodeError(error, 'ENOENT')) throw error;
            }
            let descriptor: number | undefined;
            let created = false;
            try {
                descriptor = fs.openSync(
                    candidate,
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
                    0o600,
                );
                created = true;
                assertOpenedDescriptorWithin(roots.exportsDirectory, descriptor, 'Opened export file');
                const createdStats = fs.fstatSync(descriptor);
                if (!createdStats.isFile() || createdStats.nlink !== 1) {
                    throw new Error('Export destination must be a singly linked regular file.');
                }
                fs.writeFileSync(descriptor, contents);
                fs.fsyncSync(descriptor);
                const finalStats = fs.fstatSync(descriptor);
                if (finalStats.nlink !== 1 || finalStats.size !== byteLength) {
                    throw new Error('Export destination changed while it was being written.');
                }
                fs.closeSync(descriptor);
                descriptor = undefined;
                syncDirectory(directory);
                return { path: candidate, size: byteLength };
            } catch (error) {
                if (descriptor !== undefined) {
                    try {
                        fs.closeSync(descriptor);
                    } catch {
                        // Preserve the original write error.
                    }
                }
                if (created) {
                    try {
                        fs.unlinkSync(candidate);
                    } catch (cleanupError) {
                        if (!isNodeError(cleanupError, 'ENOENT')) {
                            console.error(`Failed to remove incomplete export ${candidate}:`, cleanupError);
                        }
                    }
                }
                if (isNodeError(error, 'EEXIST')) continue;
                throw error;
            }
        }
        throw new Error(`Could not allocate a unique export filename for ${safeFilename}.`);
    }, stateDirectory);
}

function validateScheduleId(scheduleId: string): void {
    if (!SCHEDULE_ID_PATTERN.test(scheduleId)) {
        throw new Error('Scheduled email ID contains invalid characters.');
    }
}

function writeAll(descriptor: number, buffer: Buffer, length: number): void {
    let offset = 0;
    while (offset < length) offset += fs.writeSync(descriptor, buffer, offset, length - offset);
}

function copySnapshotToSpool(
    snapshot: AttachmentSnapshot,
    spoolRoot: string,
    filePath: string,
): { size: number; sha256: string } {
    const source = openResolvedAttachment(snapshot, snapshot);
    let destination: number | undefined;
    try {
        destination = fs.openSync(
            filePath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
                (fs.constants.O_NOFOLLOW ?? 0),
            0o600,
        );
        assertOpenedDescriptorWithin(spoolRoot, destination, 'Opened scheduled attachment');
        if (fs.fstatSync(destination).nlink !== 1) {
            throw new Error('Scheduled spool files must not be multiply linked.');
        }
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
        let copied = 0;
        while (true) {
            const read = fs.readSync(source.descriptor, buffer, 0, buffer.length, null);
            if (read === 0) break;
            copied += read;
            if (copied > snapshot.size || copied > MAX_ATTACHMENT_FILE_BYTES) {
                throw new Error('Managed attachment changed while it was being copied.');
            }
            hash.update(buffer.subarray(0, read));
            writeAll(destination, buffer, read);
        }
        assertStableSnapshot(source.stats, fs.fstatSync(source.descriptor));
        if (copied !== snapshot.size) throw new Error('Managed attachment changed while it was being copied.');
        fs.fsyncSync(destination);
        const destinationStats = fs.fstatSync(destination);
        if (destinationStats.nlink !== 1 || destinationStats.size !== copied) {
            throw new Error('Scheduled spool file changed while it was being written.');
        }
        return { size: copied, sha256: hash.digest('hex') };
    } finally {
        fs.closeSync(source.descriptor);
        if (destination !== undefined) fs.closeSync(destination);
    }
}

export function spoolScheduledAttachments(
    scheduleId: string,
    inputPaths: string[],
    stateDirectory = getStateDirectory(),
): ScheduledAttachment[] {
    return withStateLockSync(() => {
        validateScheduleId(scheduleId);
        if (!Array.isArray(inputPaths)) throw new Error('Scheduled attachment paths must be an array.');
        if (inputPaths.length === 0) return [];
        const snapshots = inspectAttachmentSet(inputPaths, stateDirectory);
        const aggregateBytes = snapshots.reduce((total, attachment) => total + attachment.size, 0);
        const roots = ensureManagedRoots(stateDirectory);
        const currentUsage = directoryRegularFileBytes(roots.scheduledAttachmentsDirectory);
        if (currentUsage + aggregateBytes > MAX_SCHEDULED_SPOOL_BYTES) {
            throw new Error(`Scheduled attachment quota of ${MAX_SCHEDULED_SPOOL_BYTES} bytes would be exceeded.`);
        }
        const bundleId = `${scheduleId}-${randomUUID()}`;
        const stagingDirectory = path.join(roots.scheduledAttachmentsDirectory, `.${bundleId}.tmp`);
        const finalDirectory = path.join(roots.scheduledAttachmentsDirectory, bundleId);
        fs.mkdirSync(stagingDirectory, { mode: 0o700 });
        let committed = false;
        try {
            const attachments = snapshots.map((snapshot, index) => {
                const spoolFilename = `${String(index).padStart(4, '0')}-${randomUUID()}.bin`;
                const copied = copySnapshotToSpool(
                    snapshot,
                    roots.scheduledAttachmentsDirectory,
                    path.join(stagingDirectory, spoolFilename),
                );
                return {
                    ownerId: scheduleId,
                    bundleId,
                    relativePath: path.posix.join(
                        SCHEDULED_ATTACHMENTS_DIRECTORY_NAME,
                        bundleId,
                        spoolFilename,
                    ),
                    filename: snapshot.filename,
                    size: copied.size,
                    sha256: copied.sha256,
                };
            });
            syncDirectory(stagingDirectory);
            fs.renameSync(stagingDirectory, finalDirectory);
            committed = true;
            syncDirectory(roots.scheduledAttachmentsDirectory);
            return attachments;
        } catch (error) {
            fs.rmSync(committed ? finalDirectory : stagingDirectory, { recursive: true, force: true });
            throw error;
        }
    }, stateDirectory);
}

export function isScheduledAttachment(value: unknown): value is ScheduledAttachment {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ScheduledAttachment>;
    return (
        typeof candidate.ownerId === 'string' && SCHEDULE_ID_PATTERN.test(candidate.ownerId) &&
        typeof candidate.bundleId === 'string' && candidate.bundleId.startsWith(`${candidate.ownerId}-`) &&
        typeof candidate.relativePath === 'string' && candidate.relativePath.length <= MAX_MANAGED_PATH_LENGTH &&
        typeof candidate.filename === 'string' && candidate.filename.length > 0 && candidate.filename.length <= 240 &&
        Number.isSafeInteger(candidate.size) && (candidate.size ?? -1) >= 0 &&
        (candidate.size ?? MAX_ATTACHMENT_FILE_BYTES + 1) <= MAX_ATTACHMENT_FILE_BYTES &&
        typeof candidate.sha256 === 'string' && SHA256_PATTERN.test(candidate.sha256)
    );
}

export function toScheduledAttachmentMetadata(
    attachments: ScheduledAttachment[] | undefined,
): ScheduledAttachmentMetadata[] | undefined {
    if (!attachments || attachments.length === 0) return undefined;
    return attachments.map(({ filename, size, sha256 }) => ({ filename, size, sha256 }));
}

function resolveScheduledAttachment(
    ownerId: string,
    attachment: ScheduledAttachment,
    stateDirectory: string,
): { root: string; filePath: string; bundleDirectory: string } {
    validateScheduleId(ownerId);
    if (!isScheduledAttachment(attachment) || attachment.ownerId !== ownerId) {
        throw new Error('Scheduled attachment does not belong to this scheduled email.');
    }
    const segments = relativeSegments(attachment.relativePath, 'Scheduled attachment path');
    if (
        segments.length !== 3 || segments[0] !== SCHEDULED_ATTACHMENTS_DIRECTORY_NAME ||
        segments[1] !== attachment.bundleId
    ) {
        throw new Error('Scheduled attachment path is outside its owned managed spool.');
    }
    const roots = ensureManagedRoots(stateDirectory);
    const bundleDirectory = path.join(roots.scheduledAttachmentsDirectory, attachment.bundleId);
    return {
        root: roots.scheduledAttachmentsDirectory,
        filePath: path.join(bundleDirectory, segments[2]),
        bundleDirectory,
    };
}

function inspectScheduledAttachment(
    ownerId: string,
    attachment: ScheduledAttachment,
    stateDirectory: string,
): AttachmentSnapshot {
    const resolved = resolveScheduledAttachment(ownerId, attachment, stateDirectory);
    const base: ResolvedAttachment = {
        root: resolved.root,
        filePath: resolved.filePath,
        filename: cleanDisplayFilename(attachment.filename, 'attachment'),
    };
    const opened = openResolvedAttachment(base);
    try {
        if (opened.stats.size !== attachment.size) {
            throw new Error('Scheduled attachment failed its integrity check.');
        }
        return {
            ...base,
            dev: opened.stats.dev,
            ino: opened.stats.ino,
            size: opened.stats.size,
            mtimeMs: opened.stats.mtimeMs,
        };
    } finally {
        fs.closeSync(opened.descriptor);
    }
}

function validateScheduledAttachmentSet(
    ownerId: string,
    attachments: ScheduledAttachment[],
    stateDirectory: string,
): AttachmentSnapshot[] {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENT_COUNT) {
        throw new Error(`At most ${MAX_ATTACHMENT_COUNT} scheduled attachments are allowed.`);
    }
    const relativePaths = new Set<string>();
    let aggregateBytes = 0;
    return attachments.map(attachment => {
        if (relativePaths.has(attachment.relativePath)) {
            throw new Error('Duplicate scheduled attachment descriptors are not allowed.');
        }
        relativePaths.add(attachment.relativePath);
        aggregateBytes += attachment.size;
        if (aggregateBytes > MAX_ATTACHMENT_AGGREGATE_BYTES) {
            throw new Error('Scheduled attachment aggregate exceeds the Gmail attachment limit.');
        }
        return inspectScheduledAttachment(ownerId, attachment, stateDirectory);
    });
}

function hashSnapshot(snapshot: AttachmentSnapshot): string {
    const opened = openResolvedAttachment(snapshot, snapshot);
    try {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
        let total = 0;
        while (true) {
            const read = fs.readSync(opened.descriptor, buffer, 0, buffer.length, null);
            if (read === 0) break;
            total += read;
            hash.update(buffer.subarray(0, read));
        }
        assertStableSnapshot(opened.stats, fs.fstatSync(opened.descriptor));
        if (total !== snapshot.size) throw new Error('Scheduled attachment changed while hashing.');
        return hash.digest('hex');
    } finally {
        fs.closeSync(opened.descriptor);
    }
}

export function verifyScheduledAttachments(
    ownerId: string,
    attachments: ScheduledAttachment[],
    stateDirectory = getStateDirectory(),
): void {
    const snapshots = validateScheduledAttachmentSet(ownerId, attachments, stateDirectory);
    snapshots.forEach((snapshot, index) => {
        if (hashSnapshot(snapshot) !== attachments[index].sha256) {
            throw new Error('Scheduled attachment failed its integrity check.');
        }
    });
}

export function loadScheduledAttachments(
    ownerId: string,
    attachments: ScheduledAttachment[],
    stateDirectory = getStateDirectory(),
): PreparedEmailAttachment[] {
    const snapshots = validateScheduledAttachmentSet(ownerId, attachments, stateDirectory);
    return snapshots.map((snapshot, index) => {
        const content = readSnapshot(snapshot);
        if (createHash('sha256').update(content).digest('hex') !== attachments[index].sha256) {
            throw new Error('Scheduled attachment failed its integrity check.');
        }
        return { filename: snapshot.filename, content };
    });
}

export function removeScheduledAttachments(
    ownerId: string,
    attachments: ScheduledAttachment[] | undefined,
    stateDirectory = getStateDirectory(),
): void {
    if (!attachments || attachments.length === 0) return;
    withStateLockSync(() => {
        const bundleDirectories = new Set(
            attachments.map(
                attachment => resolveScheduledAttachment(ownerId, attachment, stateDirectory).bundleDirectory,
            ),
        );
        for (const bundleDirectory of bundleDirectories) {
            fs.rmSync(bundleDirectory, { recursive: true, force: true });
        }
    }, stateDirectory);
}

export function cleanupOrphanedScheduledAttachments(
    references: ScheduledAttachmentReference[],
    stateDirectory = getStateDirectory(),
): void {
    withStateLockSync(() => {
        const roots = ensureManagedRoots(stateDirectory);
        const referencedBundles = new Set<string>();
        for (const reference of references) {
            for (const attachment of reference.attachments) {
                const resolved = resolveScheduledAttachment(
                    reference.ownerId,
                    attachment,
                    stateDirectory,
                );
                referencedBundles.add(path.basename(resolved.bundleDirectory));
            }
        }
        for (const entry of fs.readdirSync(roots.scheduledAttachmentsDirectory, { withFileTypes: true })) {
            if (referencedBundles.has(entry.name)) continue;
            fs.rmSync(path.join(roots.scheduledAttachmentsDirectory, entry.name), {
                recursive: true,
                force: true,
            });
        }
    }, stateDirectory);
}

export function safeSuggestedFilename(filename: string, fallback: string): string {
    return validateOutputFilename(cleanDisplayFilename(filename, fallback));
}
