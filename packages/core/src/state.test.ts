import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_STATE,
  ensureConfigDir,
  loadConfig,
  loadState,
  parseConfig,
  saveConfig,
  saveState,
} from './state.js';
import { configPath, statePath } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-state-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

describe('config I/O', () => {
  it('round-trips a config through save+load', async () => {
    await ensureConfigDir(root);
    await saveConfig(root, {
      site_url: 'https://example.com',
      content_dir: '.',
      enabled_types: ['post', 'page'],
      username: 'alice',
    });
    const cfg = await loadConfig(root);
    expect(cfg.site_url).toBe('https://example.com');
    expect(cfg.enabled_types).toEqual(['post', 'page']);
    expect(cfg.username).toBe('alice');
  });

  it('parseConfig rejects missing site_url', () => {
    expect(() =>
      parseConfig({ content_dir: '.', enabled_types: ['post'], username: 'a' }),
    ).toThrow(/site_url/);
  });

  it('parseConfig rejects unsupported enabled_types', () => {
    expect(() =>
      parseConfig({
        site_url: 'x',
        content_dir: '.',
        enabled_types: ['banana'],
        username: 'a',
      }),
    ).toThrow(/banana/);
  });

  it('saveConfig writes to .wpsync/config.toml', async () => {
    await ensureConfigDir(root);
    await saveConfig(root, {
      site_url: 'https://x',
      content_dir: '.',
      enabled_types: ['post'],
      username: 'a',
    });
    const text = await fs.readFile(configPath(root), 'utf8');
    expect(text).toContain('site_url');
    expect(text).toContain('https://x');
  });
});

describe('state I/O', () => {
  it('loadState returns EMPTY_STATE when state.json is missing', async () => {
    const s = await loadState(root);
    expect(s).toEqual(EMPTY_STATE);
  });

  it('saveState then loadState round-trips last_sync', async () => {
    await ensureConfigDir(root);
    await saveState(root, { schema_version: 1, last_sync: '2026-01-02T03:04:05' });
    const s = await loadState(root);
    expect(s.last_sync).toBe('2026-01-02T03:04:05');
  });

  it('saveState writes valid JSON to .wpsync/state.json', async () => {
    await ensureConfigDir(root);
    await saveState(root, { schema_version: 1, last_sync: null });
    const text = await fs.readFile(statePath(root), 'utf8');
    expect(JSON.parse(text)).toEqual({ schema_version: 1, last_sync: null });
  });
});
