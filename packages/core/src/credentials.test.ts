import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('keytar', () => {
  throw new Error('keytar unavailable in test');
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-creds-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

describe('CredentialStore (fallback path)', () => {
  it('round-trips a password through the encrypted file', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);
    expect(await store.backendName()).toBe('fallback');

    expect(await store.get('https://example.com')).toBeNull();

    await store.set('https://example.com', 'super-secret-app-password');
    const got = await store.get('https://example.com');
    expect(got).toBe('super-secret-app-password');
  });

  it('does not persist the plaintext to disk', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const { promises: fs } = await import('node:fs');
    const store = createCredentialStore(root);

    await store.set('https://example.com', 'plaintext-marker-xyz');
    const path = join(root, '.wpsync', 'secrets.json');
    const text = await fs.readFile(path, 'utf8');
    expect(text).not.toContain('plaintext-marker-xyz');
  });

  it('clear() removes the entry', async () => {
    const { createCredentialStore } = await import('./credentials.js');
    const store = createCredentialStore(root);

    await store.set('https://example.com', 'pw');
    await store.clear('https://example.com');
    expect(await store.get('https://example.com')).toBeNull();
  });
});
