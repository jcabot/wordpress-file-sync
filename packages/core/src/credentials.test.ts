import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-creds-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

describe('CredentialStore', () => {
  it('round-trips a password through credentials.json', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);

    expect(await store.get('https://example.com')).toBeNull();

    await store.set('https://example.com', 'super-secret-app-password');
    expect(await store.get('https://example.com')).toBe('super-secret-app-password');
  });

  it('writes a plain-JSON credentials.json under .wpsync/', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);

    await store.set('https://example.com', 'plaintext-marker-xyz');
    const path = join(root, '.wpsync', 'credentials.json');
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.entries['https://example.com']).toBe('plaintext-marker-xyz');
  });

  it('writes credentials.json with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);
    await store.set('https://example.com', 'pw');
    const path = join(root, '.wpsync', 'credentials.json');
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('clear() removes the entry', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);

    await store.set('https://example.com', 'pw');
    await store.clear('https://example.com');
    expect(await store.get('https://example.com')).toBeNull();
  });
});
