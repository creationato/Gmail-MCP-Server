import fs from 'fs';
import path from 'path';
import os from 'os';

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
  attachments?: string[];
  scheduledTime: string; // ISO String
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  errorMessage?: string;
  actualSentTime?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');
const QUEUE_FILE = path.join(CONFIG_DIR, 'scheduled_queue.json');

// Ensure directories exist
export function ensureDirectories() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  }
}

// Load scheduled queue
export function loadQueue(): ScheduledEmail[] {
  ensureDirectories();
  if (!fs.existsSync(QUEUE_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(QUEUE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading scheduled queue:', error);
    return [];
  }
}

// Save scheduled queue
export function saveQueue(queue: ScheduledEmail[]) {
  ensureDirectories();
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('Error saving scheduled queue:', error);
  }
}

// List all active accounts based on credentials files in ~/.gmail-mcp/accounts/
export function listAuthenticatedAccounts(): string[] {
  ensureDirectories();
  try {
    const files = fs.readdirSync(ACCOUNTS_DIR);
    return files
      .filter(file => file.endsWith('.json'))
      .map(file => file.slice(0, -5)); // remove '.json' extension to get email address
  } catch (error) {
    console.error('Error listing authenticated accounts:', error);
    return [];
  }
}

// Check if a specific account is authenticated
export function isAccountAuthenticated(email: string): boolean {
  ensureDirectories();
  const filePath = path.join(ACCOUNTS_DIR, `${email}.json`);
  return fs.existsSync(filePath);
}

// Path to an account's credential file
export function getAccountCredentialsPath(email: string): string {
  ensureDirectories();
  return path.join(ACCOUNTS_DIR, `${email}.json`);
}
