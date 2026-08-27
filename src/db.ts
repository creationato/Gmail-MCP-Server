import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  cleanupOrphanedScheduledAttachments,
  ensureManagedFileDirectories,
  isScheduledAttachment,
  MAX_ATTACHMENT_AGGREGATE_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_MANAGED_PATH_LENGTH,
  removeScheduledAttachments,
  spoolScheduledAttachments,
  toScheduledAttachmentMetadata,
  verifyScheduledAttachments,
  type ScheduledAttachment,
  type ScheduledAttachmentMetadata,
  type ScheduledAttachmentReference,
} from './managed-files.js';
import { ensureStateDirectory, getStateDirectory } from './state.js';
import { withStateLockSync } from './state-lock.js';

export { acquireSchedulerLease, SchedulerLeaseError } from './state-lock.js';

export const QUEUE_SCHEMA_VERSION = 1;
export const MAX_SCHEDULED_QUEUE_RECORDS = 500;
export const MAX_QUEUE_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_QUEUE_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_SCHEDULED_BODY_CHARS = 200_000;
export const MAX_SCHEDULED_SUBJECT_CHARS = 998;
export const MAX_SCHEDULED_RECIPIENTS = 100;
export const UNCERTAIN_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGACY_MIGRATION_FAILURE_MESSAGE =
  'Legacy scheduled email could not be migrated safely; reschedule it manually.';

const MAX_ERROR_MESSAGE_CHARS = 4096;
const MAX_ID_CHARS = 128;
const MAX_ACCOUNT_CHARS = 320;
const MAX_ADDRESS_CHARS = 320;
const MAX_THREAD_VALUE_CHARS = 2048;
const QUEUE_FILE_NAME = 'scheduled_queue.json';
const ACCOUNT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SCHEDULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE_MAX_CHARS = 64;
const LEGACY_SCHEDULED_ATTACHMENTS_DIRECTORY = 'scheduled-attachments';

export type ScheduledEmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
export type UncertainResolution = 'sent' | 'failed';

export interface ScheduledEmail {
  id: string;
  account: string;
  to: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  cc?: string[];
  bcc?: string[];
  threadId?: string;
  inReplyTo?: string;
  attachments?: ScheduledAttachment[];
  attachmentMetadata?: ScheduledAttachmentMetadata[];
  scheduledTime: string;
  status: ScheduledEmailStatus;
  attempts: number;
  errorMessage?: string;
  actualSentTime?: string;
  lastAttemptTime?: string;
  gmailMessageId?: string;
  uncertainSince?: string;
  attachmentRetentionExpiresAt?: string;
  attachmentRetentionExpiredAt?: string;
}

interface QueueDocument {
  version: typeof QUEUE_SCHEMA_VERSION;
  records: ScheduledEmail[];
}

interface LegacyMigrationResult {
  records: ScheduledEmail[];
  createdAttachments: ScheduledAttachmentReference[];
}

export const CONFIG_DIR = getStateDirectory();
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');
const QUEUE_FILE = path.join(CONFIG_DIR, QUEUE_FILE_NAME);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isValidDateString(value: string): boolean {
  return value.length <= ISO_DATE_MAX_CHARS && Number.isFinite(Date.parse(value));
}

const DateStringSchema = z.string().min(1).max(ISO_DATE_MAX_CHARS).refine(isValidDateString, {
  message: 'Expected a valid date string.',
});
const AddressSchema = z.string().min(1).max(MAX_ADDRESS_CHARS);
const AddressListSchema = z.array(AddressSchema).max(MAX_SCHEDULED_RECIPIENTS);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ScheduledAttachmentMetadataSchema = z.object({
  filename: z.string().min(1).max(240).refine(
    value => value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value),
    'Attachment filename must be a plain display filename.',
  ),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_FILE_BYTES),
  sha256: Sha256Schema,
}).strict();

const ScheduledAttachmentSchema = ScheduledAttachmentMetadataSchema.extend({
  ownerId: z.string().regex(SCHEDULE_ID_PATTERN),
  bundleId: z.string().min(38).max(MAX_ID_CHARS + 37).regex(/^[A-Za-z0-9_-]+$/),
  relativePath: z.string().min(1).max(MAX_MANAGED_PATH_LENGTH).refine(
    value => !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value),
    'Scheduled attachment path is invalid.',
  ),
}).strict();

const ScheduledEmailSchema = z.object({
  id: z.string().regex(SCHEDULE_ID_PATTERN),
  account: z.string().min(1).max(MAX_ACCOUNT_CHARS),
  to: AddressListSchema,
  subject: z.string().max(MAX_SCHEDULED_SUBJECT_CHARS),
  body: z.string().max(MAX_SCHEDULED_BODY_CHARS),
  htmlBody: z.string().max(MAX_SCHEDULED_BODY_CHARS).optional(),
  cc: AddressListSchema.optional(),
  bcc: AddressListSchema.optional(),
  threadId: z.string().max(MAX_THREAD_VALUE_CHARS).optional(),
  inReplyTo: z.string().max(MAX_THREAD_VALUE_CHARS).optional(),
  attachments: z.array(ScheduledAttachmentSchema).max(MAX_ATTACHMENT_COUNT).optional(),
  attachmentMetadata: z.array(ScheduledAttachmentMetadataSchema).max(MAX_ATTACHMENT_COUNT).optional(),
  scheduledTime: DateStringSchema,
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'uncertain']),
  attempts: z.number().int().nonnegative().max(1000),
  errorMessage: z.string().max(MAX_ERROR_MESSAGE_CHARS).optional(),
  actualSentTime: DateStringSchema.optional(),
  lastAttemptTime: DateStringSchema.optional(),
  gmailMessageId: z.string().max(MAX_THREAD_VALUE_CHARS).optional(),
  uncertainSince: DateStringSchema.optional(),
  attachmentRetentionExpiresAt: DateStringSchema.optional(),
  attachmentRetentionExpiredAt: DateStringSchema.optional(),
}).strict().superRefine((email, context) => {
  const attachments = email.attachments ?? [];
  const metadata = email.attachmentMetadata ?? [];
  const aggregate = attachments.reduce((total, attachment) => total + attachment.size, 0);
  if (aggregate > MAX_ATTACHMENT_AGGREGATE_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Attachment aggregate exceeds Gmail limits.' });
  }
  const paths = new Set<string>();
  const bundleIds = new Set<string>();
  for (const attachment of attachments) {
    const segments = attachment.relativePath.split('/');
    if (
      attachment.ownerId !== email.id ||
      !attachment.bundleId.startsWith(`${email.id}-`) ||
      segments.length !== 3 ||
      segments[0] !== LEGACY_SCHEDULED_ATTACHMENTS_DIRECTORY ||
      segments[1] !== attachment.bundleId ||
      !segments[2] || segments[2] === '.' || segments[2] === '..'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Scheduled attachment ownership is invalid.',
      });
    }
    if (paths.has(attachment.relativePath)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate attachment descriptor.' });
    }
    paths.add(attachment.relativePath);
    bundleIds.add(attachment.bundleId);
  }
  if (bundleIds.size > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Attachments must use one owned bundle.' });
  }
  if (metadata.reduce((total, attachment) => total + attachment.size, 0) > MAX_ATTACHMENT_AGGREGATE_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Attachment metadata exceeds limits.' });
  }
  if ((email.status === 'sent' || email.status === 'failed') && attachments.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Definitive outcomes cannot retain spool paths.' });
  }
  if (email.status === 'uncertain' && attachments.length > 0) {
    if (!email.uncertainSince || !email.attachmentRetentionExpiresAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Uncertain attachment retention metadata is required.',
      });
    }
    if (metadata.length !== attachments.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Uncertain attachment metadata must remain immutable.',
      });
    } else if (metadata.some((item, index) => (
      item.filename !== attachments[index].filename ||
      item.size !== attachments[index].size ||
      item.sha256 !== attachments[index].sha256
    ))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Uncertain attachment metadata must match retained bytes.',
      });
    }
  }
});

const QueueDocumentSchema = z.object({
  version: z.literal(QUEUE_SCHEMA_VERSION),
  records: z.array(ScheduledEmailSchema).max(MAX_SCHEDULED_QUEUE_RECORDS),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  for (const record of document.records) {
    if (ids.has(record.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Scheduled email IDs must be unique.' });
    }
    ids.add(record.id);
  }
});

export function atomicWriteFile(filePath: string, contents: string, mode = 0o600): void {
  const directory = path.dirname(filePath);
  ensureStateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      console.error(`Atomic write committed at ${filePath}, but directory sync failed:`, error);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError, 'ENOENT')) {
        console.error(`Failed to remove temporary file ${temporaryPath}:`, cleanupError);
      }
    }
    throw error;
  }
}

export function ensureDirectories(): void {
  ensureStateDirectory(CONFIG_DIR);
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  ensureManagedFileDirectories(CONFIG_DIR);
}

function queueFileContents(): string | undefined {
  ensureDirectories();
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      QUEUE_FILE,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('Scheduled queue must be a singly linked regular file.');
    }
    if (stats.size > MAX_QUEUE_DOCUMENT_BYTES) {
      throw new Error(`Scheduled queue exceeds the ${MAX_QUEUE_DOCUMENT_BYTES}-byte limit.`);
    }
    const contents = fs.readFileSync(descriptor, 'utf8');
    const finalStats = fs.fstatSync(descriptor);
    if (
      finalStats.nlink !== 1 || finalStats.dev !== stats.dev || finalStats.ino !== stats.ino ||
      finalStats.size !== stats.size || finalStats.mtimeMs !== stats.mtimeMs
    ) {
      throw new Error('Scheduled queue changed while it was being read.');
    }
    return contents;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateQueueDocument(value: unknown): QueueDocument {
  const document = QueueDocumentSchema.parse(value) as QueueDocument;
  for (const record of document.records) {
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_QUEUE_RECORD_BYTES) {
      throw new Error(`Scheduled email ${record.id} exceeds the per-record storage limit.`);
    }
  }
  return document;
}

function writeQueueDocument(records: ScheduledEmail[]): void {
  const document = validateQueueDocument({ version: QUEUE_SCHEMA_VERSION, records });
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_QUEUE_DOCUMENT_BYTES) {
    throw new Error(`Scheduled queue exceeds the ${MAX_QUEUE_DOCUMENT_BYTES}-byte limit.`);
  }
  atomicWriteFile(QUEUE_FILE, contents);
}

function boundedLegacyString(value: unknown, maximum: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > maximum || (required && value.length === 0)) {
    throw new Error('Invalid legacy string field.');
  }
  return value;
}

function boundedLegacyStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SCHEDULED_RECIPIENTS) {
    throw new Error('Invalid legacy address list.');
  }
  return value.map(item => {
    const parsed = boundedLegacyString(item, MAX_ADDRESS_CHARS, true);
    if (parsed === undefined) throw new Error('Invalid legacy address.');
    return parsed;
  });
}

function boundedLegacyAttempts(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    throw new Error('Invalid legacy attempts field.');
  }
  return value as number;
}

function migrationFailureId(value: unknown, index: number, usedIds: Set<string>): string {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined;
  if (typeof candidate === 'string' && SCHEDULE_ID_PATTERN.test(candidate) && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }
  while (true) {
    const generated = `legacy-failed-${index}-${randomUUID().slice(0, 8)}`;
    if (!usedIds.has(generated)) {
      usedIds.add(generated);
      return generated;
    }
  }
}

function migrationFailureRecord(id: string, now: Date): ScheduledEmail {
  return {
    id,
    account: 'default',
    to: [],
    subject: 'Legacy scheduled email migration failed',
    body: '',
    scheduledTime: now.toISOString(),
    status: 'failed',
    attempts: 0,
    errorMessage: LEGACY_MIGRATION_FAILURE_MESSAGE,
  };
}

function migrateLegacyDescriptor(ownerId: string, value: unknown): ScheduledAttachment {
  if (isScheduledAttachment(value)) {
    if (value.ownerId !== ownerId) throw new Error('Legacy descriptor owner mismatch.');
    return value;
  }
  const parsed = value as Partial<ScheduledAttachment>;
  if (
    !value || typeof value !== 'object' ||
    typeof parsed.relativePath !== 'string' ||
    typeof parsed.filename !== 'string' ||
    !Number.isSafeInteger(parsed.size) ||
    typeof parsed.sha256 !== 'string'
  ) {
    throw new Error('Invalid legacy attachment descriptor.');
  }
  const segments = parsed.relativePath.split('/');
  if (
    segments.length !== 3 || segments[0] !== LEGACY_SCHEDULED_ATTACHMENTS_DIRECTORY ||
    !segments[1].startsWith(`${ownerId}-`)
  ) {
    throw new Error('Legacy attachment descriptor is not owner-bound.');
  }
  const migrated: ScheduledAttachment = {
    ownerId,
    bundleId: segments[1],
    relativePath: parsed.relativePath,
    filename: parsed.filename,
    size: parsed.size as number,
    sha256: parsed.sha256,
  };
  if (!isScheduledAttachment(migrated)) throw new Error('Invalid legacy attachment descriptor.');
  return migrated;
}

function migrateLegacyAttachments(
  ownerId: string,
  value: unknown,
): { attachments?: ScheduledAttachment[]; created: boolean } {
  if (value === undefined) return { created: false };
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new Error('Invalid legacy attachments.');
  }
  if (value.length === 0) return { created: false };
  if (value.every(item => typeof item === 'string')) {
    return {
      attachments: spoolScheduledAttachments(ownerId, value as string[], CONFIG_DIR),
      created: true,
    };
  }
  if (value.some(item => typeof item === 'string')) throw new Error('Mixed legacy attachment types.');
  const attachments = value.map(item => migrateLegacyDescriptor(ownerId, item));
  verifyScheduledAttachments(ownerId, attachments, CONFIG_DIR);
  return { attachments, created: false };
}

function migrateLegacyRecord(
  value: unknown,
  index: number,
  now: Date,
  usedIds: Set<string>,
  createdAttachments: ScheduledAttachmentReference[],
): ScheduledEmail {
  const id = migrationFailureId(value, index, usedIds);
  let migratedAttachments: ScheduledAttachment[] | undefined;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid legacy queue record.');
    }
    const source = value as Record<string, unknown>;
    const status = source.status;
    if (!['pending', 'sending', 'sent', 'failed', 'uncertain'].includes(String(status))) {
      throw new Error('Invalid legacy status.');
    }
    const attachmentMigration = migrateLegacyAttachments(id, source.attachments);
    migratedAttachments = attachmentMigration.attachments;
    if (attachmentMigration.created && migratedAttachments) {
      createdAttachments.push({ ownerId: id, attachments: migratedAttachments });
    }
    const record: ScheduledEmail = {
      id,
      account: boundedLegacyString(source.account, MAX_ACCOUNT_CHARS, true)!,
      to: boundedLegacyStringArray(source.to) ?? [],
      subject: boundedLegacyString(source.subject, MAX_SCHEDULED_SUBJECT_CHARS, true)!,
      body: boundedLegacyString(source.body, MAX_SCHEDULED_BODY_CHARS, true)!,
      htmlBody: boundedLegacyString(source.htmlBody, MAX_SCHEDULED_BODY_CHARS),
      cc: boundedLegacyStringArray(source.cc),
      bcc: boundedLegacyStringArray(source.bcc),
      threadId: boundedLegacyString(source.threadId, MAX_THREAD_VALUE_CHARS),
      inReplyTo: boundedLegacyString(source.inReplyTo, MAX_THREAD_VALUE_CHARS),
      scheduledTime: boundedLegacyString(source.scheduledTime, ISO_DATE_MAX_CHARS, true)!,
      status: status as ScheduledEmailStatus,
      attempts: boundedLegacyAttempts(source.attempts),
      errorMessage: boundedLegacyString(source.errorMessage, MAX_ERROR_MESSAGE_CHARS),
      actualSentTime: boundedLegacyString(source.actualSentTime, ISO_DATE_MAX_CHARS),
      lastAttemptTime: boundedLegacyString(source.lastAttemptTime, ISO_DATE_MAX_CHARS),
      gmailMessageId: boundedLegacyString(source.gmailMessageId, MAX_THREAD_VALUE_CHARS),
      attachments: migratedAttachments,
    };
    if (record.status === 'uncertain') {
      record.attachmentMetadata = toScheduledAttachmentMetadata(migratedAttachments);
      record.uncertainSince = record.lastAttemptTime && isValidDateString(record.lastAttemptTime)
        ? record.lastAttemptTime
        : now.toISOString();
      if (migratedAttachments?.length) {
        record.attachmentRetentionExpiresAt = new Date(
          now.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS,
        ).toISOString();
      }
    } else if (record.status === 'sent' || record.status === 'failed') {
      record.attachmentMetadata = toScheduledAttachmentMetadata(migratedAttachments);
      delete record.attachments;
    }
    return ScheduledEmailSchema.parse(record) as ScheduledEmail;
  } catch {
    return migrationFailureRecord(id, now);
  }
}

function migrateLegacyQueue(value: unknown[], now = new Date()): LegacyMigrationResult {
  const usedIds = new Set<string>();
  const createdAttachments: ScheduledAttachmentReference[] = [];
  const records = value.slice(0, MAX_SCHEDULED_QUEUE_RECORDS).map((record, index) =>
    migrateLegacyRecord(record, index, now, usedIds, createdAttachments));
  if (value.length > MAX_SCHEDULED_QUEUE_RECORDS && records.length > 0) {
    records[records.length - 1] = migrationFailureRecord(records[records.length - 1].id, now);
  }
  return { records, createdAttachments };
}

function cleanupAttachmentsAfterCommit(references: ScheduledAttachmentReference[]): void {
  for (const reference of references) {
    try {
      removeScheduledAttachments(reference.ownerId, reference.attachments, CONFIG_DIR);
    } catch (error) {
      console.error('Scheduled attachment cleanup failed after queue commit:', error);
    }
  }
}

function queueReferences(records: ScheduledEmail[]): ScheduledAttachmentReference[] {
  return records
    .filter((record): record is ScheduledEmail & { attachments: ScheduledAttachment[] } =>
      Boolean(record.attachments?.length))
    .map(record => ({ ownerId: record.id, attachments: record.attachments }));
}

function readQueueDocumentUnlocked(): QueueDocument {
  const contents = queueFileContents();
  if (contents === undefined) return { version: QUEUE_SCHEMA_VERSION, records: [] };
  const parsed = JSON.parse(contents) as unknown;
  if (!Array.isArray(parsed)) return validateQueueDocument(parsed);

  const migration = migrateLegacyQueue(parsed);
  try {
    writeQueueDocument(migration.records);
  } catch (error) {
    cleanupAttachmentsAfterCommit(migration.createdAttachments);
    throw error;
  }
  cleanupOrphanedScheduledAttachments(queueReferences(migration.records), CONFIG_DIR);
  return { version: QUEUE_SCHEMA_VERSION, records: migration.records };
}

function expireUncertainAttachments(
  records: ScheduledEmail[],
  now: Date,
): { changed: boolean; cleanup: ScheduledAttachmentReference[] } {
  const cleanup: ScheduledAttachmentReference[] = [];
  let changed = false;
  for (const record of records) {
    if (
      record.status !== 'uncertain' || !record.attachments?.length ||
      !record.attachmentRetentionExpiresAt ||
      Date.parse(record.attachmentRetentionExpiresAt) > now.getTime()
    ) {
      continue;
    }
    cleanup.push({ ownerId: record.id, attachments: record.attachments });
    delete record.attachments;
    record.attachmentRetentionExpiredAt = now.toISOString();
    changed = true;
  }
  return { changed, cleanup };
}

export function loadQueue(now = new Date()): ScheduledEmail[] {
  return withStateLockSync(() => {
    const document = readQueueDocumentUnlocked();
    const expiration = expireUncertainAttachments(document.records, now);
    if (expiration.changed) writeQueueDocument(document.records);
    cleanupAttachmentsAfterCommit(expiration.cleanup);
    return structuredClone(document.records);
  }, CONFIG_DIR);
}

export function updateQueue<T>(mutator: (queue: ScheduledEmail[]) => T, now = new Date()): T {
  return withStateLockSync(() => {
    const document = readQueueDocumentUnlocked();
    const expiration = expireUncertainAttachments(document.records, now);
    const result = mutator(document.records);
    writeQueueDocument(document.records);
    cleanupAttachmentsAfterCommit(expiration.cleanup);
    return result;
  }, CONFIG_DIR);
}

export function enqueueScheduledEmail(
  email: ScheduledEmail,
  sourceAttachmentPaths: string[] = [],
): void {
  if (email.attachments !== undefined || email.attachmentMetadata !== undefined) {
    throw new Error('New scheduled emails must use managed source paths.');
  }
  if (email.status !== 'pending' || email.attempts !== 0) {
    throw new Error('New scheduled emails must start pending with zero attempts.');
  }
  if (email.to.length === 0) throw new Error('At least one scheduled recipient is required.');
  const baseEmail = ScheduledEmailSchema.parse({ ...email, attachments: undefined }) as ScheduledEmail;
  let createdAttachments: ScheduledAttachment[] | undefined;
  try {
    updateQueue(queue => {
      if (queue.length >= MAX_SCHEDULED_QUEUE_RECORDS) {
        throw new Error(`Scheduled queue limit of ${MAX_SCHEDULED_QUEUE_RECORDS} records reached.`);
      }
      if (queue.some(item => item.id === baseEmail.id)) {
        throw new Error(`Scheduled email with ID "${baseEmail.id}" already exists.`);
      }
      createdAttachments = sourceAttachmentPaths.length > 0
        ? spoolScheduledAttachments(baseEmail.id, sourceAttachmentPaths, CONFIG_DIR)
        : undefined;
      queue.push({ ...baseEmail, attachments: createdAttachments });
    });
  } catch (error) {
    if (createdAttachments) {
      cleanupAttachmentsAfterCommit([{ ownerId: baseEmail.id, attachments: createdAttachments }]);
    }
    throw error;
  }
}

export function cancelScheduledEmail(id: string): boolean {
  const result = updateQueue(queue => {
    const index = queue.findIndex(item => item.id === id && item.status === 'pending');
    if (index < 0) return { cancelled: false, cleanup: [] as ScheduledAttachmentReference[] };
    const [removed] = queue.splice(index, 1);
    return {
      cancelled: true,
      cleanup: removed.attachments
        ? [{ ownerId: removed.id, attachments: removed.attachments }]
        : [],
    };
  });
  cleanupAttachmentsAfterCommit(result.cleanup);
  return result.cancelled;
}

export function claimScheduledEmail(id: string, now = new Date()): ScheduledEmail | undefined {
  return updateQueue(queue => {
    const email = queue.find(item => item.id === id);
    if (
      !email || email.status !== 'pending' ||
      new Date(email.scheduledTime).getTime() > now.getTime()
    ) {
      return undefined;
    }
    email.status = 'sending';
    email.attempts += 1;
    email.lastAttemptTime = now.toISOString();
    delete email.errorMessage;
    return structuredClone(email);
  }, now);
}

function boundedErrorMessage(message: string): string {
  return message.replace(/[\r\n\0]+/g, ' ').slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function updateClaimedEmail(
  id: string,
  outcome: 'sent' | 'failed' | 'uncertain',
  message: string | undefined,
  gmailMessageId: string | undefined,
  now: Date,
): ScheduledEmail {
  const result = updateQueue(queue => {
    const email = queue.find(item => item.id === id);
    if (!email) throw new Error(`Scheduled email with ID "${id}" no longer exists.`);
    if (email.status !== 'sending') {
      throw new Error(`Scheduled email with ID "${id}" cannot be finalized from status "${email.status}".`);
    }
    const cleanup = outcome !== 'uncertain' && email.attachments
      ? [{ ownerId: email.id, attachments: email.attachments }]
      : [];
    email.attachmentMetadata = toScheduledAttachmentMetadata(email.attachments) ?? email.attachmentMetadata;
    email.status = outcome;
    if (message) email.errorMessage = boundedErrorMessage(message);
    if (outcome === 'sent') {
      email.actualSentTime = now.toISOString();
      if (gmailMessageId) email.gmailMessageId = gmailMessageId.slice(0, MAX_THREAD_VALUE_CHARS);
    }
    if (outcome === 'uncertain') {
      email.uncertainSince = now.toISOString();
      if (email.attachments?.length) {
        email.attachmentRetentionExpiresAt = new Date(
          now.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS,
        ).toISOString();
      }
    } else {
      delete email.attachments;
    }
    return { email: structuredClone(email), cleanup };
  }, now);
  cleanupAttachmentsAfterCommit(result.cleanup);
  return result.email;
}

export function markScheduledEmailSent(
  id: string,
  gmailMessageId: string | undefined,
  sentAt = new Date(),
): ScheduledEmail {
  return updateClaimedEmail(id, 'sent', undefined, gmailMessageId, sentAt);
}

export function markScheduledEmailFailed(
  id: string,
  message: string,
  failedAt = new Date(),
): ScheduledEmail {
  return updateClaimedEmail(id, 'failed', message, undefined, failedAt);
}

export function markScheduledEmailUncertain(
  id: string,
  message: string,
  uncertainAt = new Date(),
): ScheduledEmail {
  return updateClaimedEmail(id, 'uncertain', message, undefined, uncertainAt);
}

export function resolveUncertainScheduledEmail(
  id: string,
  outcome: UncertainResolution,
  gmailMessageId?: string,
  resolvedAt = new Date(),
): ScheduledEmail {
  const result = updateQueue(queue => {
    const email = queue.find(item => item.id === id);
    if (!email) throw new Error(`Scheduled email with ID "${id}" does not exist.`);
    if (email.status !== 'uncertain') {
      throw new Error(`Scheduled email with ID "${id}" is not awaiting uncertain-delivery resolution.`);
    }
    const cleanup = email.attachments
      ? [{ ownerId: email.id, attachments: email.attachments }]
      : [];
    email.attachmentMetadata = toScheduledAttachmentMetadata(email.attachments) ?? email.attachmentMetadata;
    delete email.attachments;
    delete email.attachmentRetentionExpiresAt;
    email.status = outcome;
    email.errorMessage = outcome === 'sent'
      ? 'Delivery was reconciled as sent.'
      : 'Delivery was reconciled as definitively failed.';
    if (outcome === 'sent') {
      email.actualSentTime = resolvedAt.toISOString();
      if (gmailMessageId) email.gmailMessageId = gmailMessageId.slice(0, MAX_THREAD_VALUE_CHARS);
    }
    return { email: structuredClone(email), cleanup };
  }, resolvedAt);
  cleanupAttachmentsAfterCommit(result.cleanup);
  return result.email;
}

export function recoverInterruptedScheduledEmails(now = new Date()): number {
  const recovered = updateQueue(queue => {
    let count = 0;
    for (const email of queue) {
      if (email.status !== 'sending') continue;
      email.status = 'uncertain';
      email.errorMessage =
        `Delivery outcome is uncertain because scheduler processing was interrupted before ${now.toISOString()}.`;
      email.attachmentMetadata = toScheduledAttachmentMetadata(email.attachments) ?? email.attachmentMetadata;
      email.uncertainSince = now.toISOString();
      if (email.attachments?.length) {
        email.attachmentRetentionExpiresAt = new Date(
          now.getTime() + UNCERTAIN_ATTACHMENT_RETENTION_MS,
        ).toISOString();
      }
      count += 1;
    }
    return count;
  }, now);
  withStateLockSync(() => {
    const records = readQueueDocumentUnlocked().records;
    cleanupOrphanedScheduledAttachments(queueReferences(records), CONFIG_DIR);
  }, CONFIG_DIR);
  return recovered;
}

export function listAuthenticatedAccounts(): string[] {
  ensureDirectories();
  try {
    return fs.readdirSync(ACCOUNTS_DIR)
      .filter(file => file.endsWith('.json'))
      .map(file => file.slice(0, -5));
  } catch (error) {
    console.error('Error listing authenticated accounts:', error);
    return [];
  }
}

export function canonicalizeAccountEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!ACCOUNT_EMAIL_PATTERN.test(normalized)) throw new Error('Invalid Gmail account email address.');
  return normalized;
}

export function isAccountAuthenticated(email: string): boolean {
  ensureDirectories();
  return fs.existsSync(path.join(ACCOUNTS_DIR, `${canonicalizeAccountEmail(email)}.json`));
}

export function getAccountCredentialsPath(email: string): string {
  ensureDirectories();
  return path.join(ACCOUNTS_DIR, `${canonicalizeAccountEmail(email)}.json`);
}
