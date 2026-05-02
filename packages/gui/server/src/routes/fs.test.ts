import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { listDirectory } from './fs.js';

describe('listDirectory', () => {
  it('lists subdirectories of an absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wpsync-fs-'));
    try {
      await mkdir(join(root, 'alpha'));
      await mkdir(join(root, 'beta'));
      await writeFile(join(root, 'a-file.txt'), 'x');
      const result = await listDirectory(root);
      expect(result.path).toBe(root);
      expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
      expect(result.entries.every((e) => e.isDir)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hides dotfiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wpsync-fs-'));
    try {
      await mkdir(join(root, '.hidden'));
      await mkdir(join(root, 'visible'));
      const result = await listDirectory(root);
      expect(result.entries.map((e) => e.name)).toEqual(['visible']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to home directory when path is missing or relative', async () => {
    const result = await listDirectory(null);
    expect(result.path).toBe(homedir());
  });

  it('reports parent=null at the filesystem root', async () => {
    const root = parse(homedir()).root;
    const result = await listDirectory(root);
    expect(result.parent).toBeNull();
  });

  it('throws for a non-existent path', async () => {
    await expect(listDirectory('/no/such/path/anywhere/ever-' + Date.now())).rejects.toThrow();
  });
});
