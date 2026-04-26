import { promises as fs } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type CipherGCMTypes,
} from 'node:crypto';
import { join } from 'node:path';
import { configDir } from './paths.js';

const SERVICE = 'wpsync';
const ALGO: CipherGCMTypes = 'aes-256-gcm';

interface KeytarLike {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

let keytarCache: KeytarLike | null | undefined;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (keytarCache !== undefined) return keytarCache;
  try {
    const mod = (await import('keytar')) as { default?: KeytarLike } & KeytarLike;
    keytarCache = mod.default ?? mod;
    return keytarCache;
  } catch {
    keytarCache = null;
    return null;
  }
}

function fallbackPath(rootDir: string): string {
  return join(configDir(rootDir), 'secrets.json');
}

function deriveKey(): Buffer {
  const salt = `${hostname()}::${userInfo().username}`;
  return scryptSync(salt, 'wpsync-fallback', 32);
}

interface FallbackEntry {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface FallbackFile {
  version: 1;
  entries: Record<string, FallbackEntry>;
}

async function readFallback(rootDir: string): Promise<FallbackFile> {
  try {
    const text = await fs.readFile(fallbackPath(rootDir), 'utf8');
    const parsed = JSON.parse(text) as FallbackFile;
    if (parsed.version !== 1 || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: {} };
    throw err;
  }
}

async function writeFallback(rootDir: string, file: FallbackFile): Promise<void> {
  const path = fallbackPath(rootDir);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // chmod is a best-effort on Windows
  }
}

function encryptValue(value: string): FallbackEntry {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptValue(entry: FallbackEntry): string {
  const key = deriveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(entry.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

export interface CredentialStore {
  get(siteUrl: string): Promise<string | null>;
  set(siteUrl: string, password: string): Promise<void>;
  clear(siteUrl: string): Promise<void>;
  backendName(): Promise<'keychain' | 'fallback'>;
}

export function createCredentialStore(rootDir: string): CredentialStore {
  return {
    async backendName() {
      return (await loadKeytar()) ? 'keychain' : 'fallback';
    },

    async get(siteUrl) {
      const k = await loadKeytar();
      if (k) return k.getPassword(SERVICE, siteUrl);
      const file = await readFallback(rootDir);
      const entry = file.entries[siteUrl];
      return entry ? decryptValue(entry) : null;
    },

    async set(siteUrl, password) {
      const k = await loadKeytar();
      if (k) {
        await k.setPassword(SERVICE, siteUrl, password);
        return;
      }
      const file = await readFallback(rootDir);
      file.entries[siteUrl] = encryptValue(password);
      await writeFallback(rootDir, file);
    },

    async clear(siteUrl) {
      const k = await loadKeytar();
      if (k) {
        await k.deletePassword(SERVICE, siteUrl);
        return;
      }
      const file = await readFallback(rootDir);
      delete file.entries[siteUrl];
      await writeFallback(rootDir, file);
    },
  };
}
