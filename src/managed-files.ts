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
export const MAX_INLINE_IMAGE_CONTENT_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_IMAGE_AGGREGATE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BASE64_CHARS = Math.ceil(MAX_INLINE_IMAGE_CONTENT_BYTES / 3) * 4;
export const MAX_MANAGED_PATH_LENGTH = 1024;

const INLINE_CONTENT_TYPE_VALUES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/x-icon',
] as const;
type InlineContentType = typeof INLINE_CONTENT_TYPE_VALUES[number];
const INLINE_CONTENT_TYPES = new Set<string>(INLINE_CONTENT_TYPE_VALUES);
const INLINE_CID_PATTERN = /^[^\s<>\x00-\x1f\x7f]{1,256}$/;

// Managed storage remains intentionally bounded even when callers never clean it manually.
export const MAX_MANAGED_EXPORT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_MANAGED_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_SCHEDULED_SPOOL_BYTES = 256 * 1024 * 1024;

export interface PreparedEmailAttachment {
    filename: string;
    content: Buffer;
    cid?: string;
    contentType?: string;
}

export interface InlineImageInput {
    cid: string;
    path?: string;
    content?: string;
    contentType?: string;
    filename?: string;
}

export interface ScheduledAttachmentMetadata {
    filename: string;
    size: number;
    sha256: string;
    cid?: string;
    contentType?: string;
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

function validateInlineCid(value: unknown): string {
    if (typeof value !== 'string' || !INLINE_CID_PATTERN.test(value)) {
        throw new Error('Inline image cid must contain 1-256 safe non-whitespace characters.');
    }
    return value;
}

function validateInlineContentType(value: unknown, required: boolean): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || !INLINE_CONTENT_TYPES.has(value)) {
        throw new Error('Inline image contentType is missing or unsupported.');
    }
    return value;
}

function hasBytes(content: Buffer, offset: number, expected: readonly number[]): boolean {
    if (offset < 0 || offset + expected.length > content.length) return false;
    return expected.every((value, index) => content[offset + index] === value);
}

function isPng(content: Buffer): boolean {
    if (!hasBytes(content, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
    let offset = 8;
    let sawHeader = false;
    let sawImageData = false;
    while (offset + 12 <= content.length) {
        const length = content.readUInt32BE(offset);
        if (length > content.length - offset - 12) return false;
        const type = content.toString('ascii', offset + 4, offset + 8);
        const chunkEnd = offset + 12 + length;
        if (!sawHeader) {
            if (type !== 'IHDR' || length !== 13) return false;
            if (content.readUInt32BE(offset + 8) === 0 || content.readUInt32BE(offset + 12) === 0) {
                return false;
            }
            sawHeader = true;
        } else if (type === 'IHDR') {
            return false;
        }
        if (type === 'IDAT') sawImageData = true;
        if (type === 'IEND') {
            return length === 0 && sawImageData && chunkEnd === content.length;
        }
        offset = chunkEnd;
    }
    return false;
}

function isJpegStartOfFrame(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isJpeg(content: Buffer): boolean {
    if (
        content.length < 14 || !hasBytes(content, 0, [0xff, 0xd8]) ||
        !hasBytes(content, content.length - 2, [0xff, 0xd9])
    ) return false;
    let offset = 2;
    let sawFrame = false;
    while (offset < content.length - 2) {
        if (content[offset] !== 0xff) return false;
        while (offset < content.length && content[offset] === 0xff) offset += 1;
        if (offset >= content.length) return false;
        const marker = content[offset++];
        if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > content.length) return false;
        const segmentLength = content.readUInt16BE(offset);
        if (segmentLength < 2 || segmentLength > content.length - offset) return false;
        if (isJpegStartOfFrame(marker)) {
            if (segmentLength < 8 || offset + 8 > content.length) return false;
            const componentCount = content[offset + 7];
            if (
                componentCount === 0 || segmentLength !== 8 + (3 * componentCount) ||
                content.readUInt16BE(offset + 3) === 0 || content.readUInt16BE(offset + 5) === 0
            ) return false;
            sawFrame = true;
        }
        if (marker === 0xda) {
            return sawFrame && segmentLength >= 6 && offset + segmentLength <= content.length - 2;
        }
        offset += segmentLength;
    }
    return false;
}

function isGif(content: Buffer): boolean {
    if (content.length < 14 || content[content.length - 1] !== 0x3b) return false;
    const version = content.toString('ascii', 0, 6);
    if (version !== 'GIF87a' && version !== 'GIF89a') return false;
    if (content.readUInt16LE(6) === 0 || content.readUInt16LE(8) === 0) return false;
    const globalColorTableBytes = (content[10] & 0x80) === 0
        ? 0
        : 3 * (2 ** ((content[10] & 0x07) + 1));
    return 13 + globalColorTableBytes < content.length;
}

function isWebp(content: Buffer): boolean {
    if (
        content.length < 25 || content.toString('ascii', 0, 4) !== 'RIFF' ||
        content.toString('ascii', 8, 12) !== 'WEBP' || content.readUInt32LE(4) + 8 !== content.length
    ) return false;
    const chunkType = content.toString('ascii', 12, 16);
    const chunkLength = content.readUInt32LE(16);
    if (chunkLength > content.length - 20) return false;
    if (chunkType === 'VP8 ') {
        return chunkLength >= 10 && content.length >= 30 && hasBytes(content, 23, [0x9d, 0x01, 0x2a]) &&
            (content.readUInt16LE(26) & 0x3fff) > 0 && (content.readUInt16LE(28) & 0x3fff) > 0;
    }
    if (chunkType === 'VP8L') {
        if (chunkLength < 5 || content[20] !== 0x2f) return false;
        const dimensions = content.readUInt32LE(21);
        return (dimensions & 0x3fff) + 1 > 0 && ((dimensions >>> 14) & 0x3fff) + 1 > 0;
    }
    if (chunkType === 'VP8X') {
        return chunkLength >= 10 && content.length >= 30 && content.readUIntLE(24, 3) + 1 > 0 &&
            content.readUIntLE(27, 3) + 1 > 0;
    }
    return false;
}

function isBmp(content: Buffer): boolean {
    if (content.length < 26 || content.toString('ascii', 0, 2) !== 'BM') return false;
    if (content.readUInt32LE(2) !== content.length) return false;
    const pixelOffset = content.readUInt32LE(10);
    const dibSize = content.readUInt32LE(14);
    if (pixelOffset < 14 + dibSize || pixelOffset > content.length) return false;
    if (dibSize === 12) {
        return content.readUInt16LE(18) > 0 && content.readUInt16LE(20) > 0;
    }
    return dibSize >= 40 && content.readInt32LE(18) > 0 && content.readInt32LE(22) !== 0;
}

function isIco(content: Buffer): boolean {
    if (content.length < 22 || !hasBytes(content, 0, [0x00, 0x00, 0x01, 0x00])) return false;
    const imageCount = content.readUInt16LE(4);
    const directoryEnd = 6 + (16 * imageCount);
    if (imageCount === 0 || directoryEnd > content.length) return false;
    for (let index = 0; index < imageCount; index += 1) {
        const entryOffset = 6 + (16 * index);
        const imageSize = content.readUInt32LE(entryOffset + 8);
        const imageOffset = content.readUInt32LE(entryOffset + 12);
        if (
            imageSize === 0 || imageOffset < directoryEnd || imageOffset > content.length ||
            imageSize > content.length - imageOffset
        ) return false;
        const image = content.subarray(imageOffset, imageOffset + imageSize);
        const dibSize = image.length >= 4 ? image.readUInt32LE(0) : 0;
        if (!isPng(image) && ![12, 40, 64, 108, 124].includes(dibSize)) return false;
    }
    return true;
}

export function detectInlineImageContentType(content: Buffer): InlineContentType | undefined {
    if (isPng(content)) return 'image/png';
    if (isJpeg(content)) return 'image/jpeg';
    if (isGif(content)) return 'image/gif';
    if (isWebp(content)) return 'image/webp';
    if (isBmp(content)) return 'image/bmp';
    if (isIco(content)) return 'image/x-icon';
    return undefined;
}

function verifiedInlineContentType(
    content: Buffer,
    suppliedContentType: string | undefined,
    cid: string,
): InlineContentType {
    const detectedContentType = detectInlineImageContentType(content);
    if (!detectedContentType) {
        throw new Error(`Inline image '${cid}' is not a supported, well-formed bitmap image.`);
    }
    if (suppliedContentType !== undefined && suppliedContentType !== detectedContentType) {
        throw new Error(
            `Inline image '${cid}' contentType ${suppliedContentType} does not match detected ${detectedContentType}.`,
        );
    }
    return detectedContentType;
}

export function hasCanonicalBase64Syntax(value: string): boolean {
    if (value.length === 0 || value.length % 4 !== 0) return false;
    let padding = 0;
    if (value.endsWith('==')) padding = 2;
    else if (value.endsWith('=')) padding = 1;
    const dataLength = value.length - padding;
    for (let index = 0; index < dataLength; index += 1) {
        const code = value.charCodeAt(index);
        if (!(
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) ||
            code === 43 ||
            code === 47
        )) return false;
    }
    for (let index = dataLength; index < value.length; index += 1) {
        if (value.charCodeAt(index) !== 61) return false;
    }
    if (padding > 0) {
        const code = value.charCodeAt(dataLength - 1);
        const sextet = code >= 65 && code <= 90 ? code - 65
            : code >= 97 && code <= 122 ? code - 71
                : code >= 48 && code <= 57 ? code + 4
                    : code === 43 ? 62 : 63;
        if ((padding === 2 && (sextet & 0x0f) !== 0) ||
            (padding === 1 && (sextet & 0x03) !== 0)) return false;
    }
    return true;
}

function decodeCanonicalBase64(value: unknown, cid: string): Buffer {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Inline image '${cid}' content must be non-empty canonical base64.`);
    }
    if (value.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
        throw new Error(`Inline image '${cid}' exceeds the ${MAX_INLINE_IMAGE_CONTENT_BYTES}-byte limit.`);
    }
    if (!hasCanonicalBase64Syntax(value)) {
        throw new Error(`Inline image '${cid}' content must be canonical base64.`);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length > MAX_INLINE_IMAGE_CONTENT_BYTES || decoded.toString('base64') !== value) {
        throw new Error(`Inline image '${cid}' content must be canonical base64 within the size limit.`);
    }
    return decoded;
}

function inlineFilename(value: unknown, fallback: string): string {
    if (value !== undefined && typeof value !== 'string') {
        throw new Error('Inline image filename must be a string.');
    }
    return cleanDisplayFilename(value ?? fallback, 'inline-image');
}

export function prepareEmailMimeParts(
    attachmentPaths: string[] = [],
    inlineImages: InlineImageInput[] = [],
    stateDirectory = getStateDirectory(),
): PreparedEmailAttachment[] {
    if (!Array.isArray(attachmentPaths) || !Array.isArray(inlineImages)) {
        throw new Error('Attachments and inlineImages must be arrays.');
    }
    if (attachmentPaths.length + inlineImages.length > MAX_ATTACHMENT_COUNT) {
        throw new Error(`At most ${MAX_ATTACHMENT_COUNT} total attachments and inline images are allowed.`);
    }

    const attachmentSnapshots = inspectAttachmentSet(attachmentPaths, stateDirectory);
    const inlineCids = new Set<string>();
    const preparedInline: Array<{
        snapshot?: AttachmentSnapshot;
        content?: Buffer;
        filename: string;
        cid: string;
        suppliedContentType?: string;
    }> = [];
    let base64Bytes = 0;

    for (const image of inlineImages) {
        if (!image || typeof image !== 'object') throw new Error('Inline image must be an object.');
        const cid = validateInlineCid(image.cid);
        if (inlineCids.has(cid)) throw new Error(`Duplicate inline image cid '${cid}' is not allowed.`);
        inlineCids.add(cid);
        const hasPath = typeof image.path === 'string' && image.path.length > 0;
        const hasContent = typeof image.content === 'string' && image.content.length > 0;
        if (hasPath === hasContent) {
            throw new Error(`Inline image '${cid}' must set exactly one of path or content.`);
        }
        if (hasPath) {
            const [snapshot] = inspectAttachmentSet([image.path!], stateDirectory);
            preparedInline.push({
                snapshot,
                filename: inlineFilename(image.filename, snapshot.filename),
                cid,
                suppliedContentType: validateInlineContentType(image.contentType, false),
            });
        } else {
            const content = decodeCanonicalBase64(image.content, cid);
            base64Bytes += content.length;
            if (base64Bytes > MAX_INLINE_IMAGE_AGGREGATE_BYTES) {
                throw new Error(
                    `Decoded inline image content exceeds the ${MAX_INLINE_IMAGE_AGGREGATE_BYTES}-byte aggregate limit.`,
                );
            }
            preparedInline.push({
                content,
                filename: inlineFilename(image.filename, cid),
                cid,
                suppliedContentType: validateInlineContentType(image.contentType, true),
            });
        }
    }

    const totalBytes = attachmentSnapshots.reduce((total, item) => total + item.size, 0) +
        preparedInline.reduce(
            (total, item) => total + (item.snapshot?.size ?? item.content?.length ?? 0),
            0,
        );
    if (totalBytes > MAX_ATTACHMENT_AGGREGATE_BYTES) {
        throw new Error(
            `Aggregate attachments and inline images exceed the ${MAX_ATTACHMENT_AGGREGATE_BYTES}-byte limit.`,
        );
    }

    return [
        ...attachmentSnapshots.map(snapshot => ({
            filename: snapshot.filename,
            content: readSnapshot(snapshot),
        })),
        ...preparedInline.map(item => {
            const content = item.content ?? readSnapshot(item.snapshot!);
            return {
                filename: item.filename,
                content,
                cid: item.cid,
                contentType: verifiedInlineContentType(content, item.suppliedContentType, item.cid),
            };
        }),
    ];
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
    while (offset < length) {
        const written = fs.writeSync(descriptor, buffer, offset, length - offset);
        if (written <= 0) throw new Error('Scheduled spool write made no progress.');
        offset += written;
    }
}

export function spoolScheduledAttachments(
    scheduleId: string,
    inputPaths: string[],
    stateDirectory = getStateDirectory(),
    inlineImages: InlineImageInput[] = [],
): ScheduledAttachment[] {
    return withStateLockSync(() => {
        validateScheduleId(scheduleId);
        if (!Array.isArray(inputPaths)) throw new Error('Scheduled attachment paths must be an array.');
        if (inputPaths.length === 0 && inlineImages.length === 0) return [];
        const parts = prepareEmailMimeParts(inputPaths, inlineImages, stateDirectory);
        const aggregateBytes = parts.reduce((total, part) => total + part.content.length, 0);
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
            const attachments = parts.map((part, index) => {
                const spoolFilename = `${String(index).padStart(4, '0')}-${randomUUID()}.bin`;
                const destination = fs.openSync(
                    path.join(stagingDirectory, spoolFilename),
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
                        (fs.constants.O_NOFOLLOW ?? 0),
                    0o600,
                );
                try {
                    assertOpenedDescriptorWithin(
                        roots.scheduledAttachmentsDirectory,
                        destination,
                        'Opened scheduled attachment',
                    );
                    if (fs.fstatSync(destination).nlink !== 1) {
                        throw new Error('Scheduled spool files must not be multiply linked.');
                    }
                    writeAll(destination, part.content, part.content.length);
                    fs.fsyncSync(destination);
                    const finalStats = fs.fstatSync(destination);
                    if (finalStats.nlink !== 1 || finalStats.size !== part.content.length) {
                        throw new Error('Scheduled spool file changed while it was being written.');
                    }
                } finally {
                    fs.closeSync(destination);
                }
                return {
                    ownerId: scheduleId,
                    bundleId,
                    relativePath: path.posix.join(
                        SCHEDULED_ATTACHMENTS_DIRECTORY_NAME,
                        bundleId,
                        spoolFilename,
                    ),
                    filename: part.filename,
                    size: part.content.length,
                    sha256: createHash('sha256').update(part.content).digest('hex'),
                    ...(part.cid ? { cid: part.cid } : {}),
                    ...(part.contentType ? { contentType: part.contentType } : {}),
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
        typeof candidate.filename === 'string' && candidate.filename.length > 0 &&
        candidate.filename.length <= 240 && candidate.filename !== '.' && candidate.filename !== '..' &&
        !/[\\/\x00-\x1f\x7f]/.test(candidate.filename) &&
        Number.isSafeInteger(candidate.size) && (candidate.size ?? -1) >= 0 &&
        (candidate.size ?? MAX_ATTACHMENT_FILE_BYTES + 1) <= MAX_ATTACHMENT_FILE_BYTES &&
        typeof candidate.sha256 === 'string' && SHA256_PATTERN.test(candidate.sha256) &&
        (candidate.cid === undefined || (
            typeof candidate.cid === 'string' && INLINE_CID_PATTERN.test(candidate.cid)
        )) &&
        (candidate.contentType === undefined || (
            typeof candidate.contentType === 'string' && INLINE_CONTENT_TYPES.has(candidate.contentType)
        )) &&
        (candidate.cid !== undefined || candidate.contentType === undefined)
    );
}

export function toScheduledAttachmentMetadata(
    attachments: ScheduledAttachment[] | undefined,
): ScheduledAttachmentMetadata[] | undefined {
    if (!attachments || attachments.length === 0) return undefined;
    return attachments.map(({ filename, size, sha256, cid, contentType }) => ({
        filename,
        size,
        sha256,
        ...(cid ? { cid } : {}),
        ...(contentType ? { contentType } : {}),
    }));
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
    const inlineCids = new Set<string>();
    let aggregateBytes = 0;
    return attachments.map(attachment => {
        if (relativePaths.has(attachment.relativePath)) {
            throw new Error('Duplicate scheduled attachment descriptors are not allowed.');
        }
        relativePaths.add(attachment.relativePath);
        if (attachment.cid) {
            if (inlineCids.has(attachment.cid)) {
                throw new Error('Duplicate scheduled inline image cids are not allowed.');
            }
            inlineCids.add(attachment.cid);
        }
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
        return {
            filename: snapshot.filename,
            content,
            ...(attachments[index].cid ? { cid: attachments[index].cid } : {}),
            ...(attachments[index].contentType
                ? { contentType: attachments[index].contentType }
                : {}),
        };
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
