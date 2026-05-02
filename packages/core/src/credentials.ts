import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from './paths.js';

function credentialsPath(rootDir: string): string {
  return join(configDir(rootDir), 'credentials.json');
}

interface CredentialsFile {
  version: 1;
  entries: Record<string, string>;
}

async function readFile(rootDir: string): Promise<CredentialsFile> {
  try {
    const text = await fs.readFile(credentialsPath(rootDir), 'utf8');
    const parsed = JSON.parse(text) as CredentialsFile;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} };
    throw err;
  }
}

async function writeFile(rootDir: string, file: CredentialsFile): Promise<void> {
  const path = credentialsPath(rootDir);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // chmod is best-effort on Windows
  }
}

export interface CredentialStore {
  get(siteUrl: string): Promise<string | null>;
  set(siteUrl: string, password: string): Promise<void>;
  clear(siteUrl: string): Promise<void>;
}

export function createCredentialStore(rootDir: string): CredentialStore {
  return {
    async get(siteUrl) {
      const file = await readFile(rootDir);
      return file.entries[siteUrl] ?? null;
    },

    async set(siteUrl, password) {
      const file = await readFile(rootDir);
      file.entries[siteUrl] = password;
      await writeFile(rootDir, file);
    },

    async clear(siteUrl) {
      const file = await readFile(rootDir);
      delete file.entries[siteUrl];
      await writeFile(rootDir, file);
    },
  };
}
