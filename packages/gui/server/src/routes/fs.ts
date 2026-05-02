import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { Router } from 'express';

interface Entry {
  name: string;
  isDir: boolean;
}

export interface ListResult {
  path: string;
  parent: string | null;
  entries: Entry[];
}

export async function listDirectory(rawPath: string | undefined | null): Promise<ListResult> {
  const path = !rawPath || !isAbsolute(rawPath) ? homedir() : resolve(rawPath);
  const stats = await fs.stat(path);
  if (!stats.isDirectory()) throw new Error('Not a directory');
  const dirents = await fs.readdir(path, { withFileTypes: true });
  const entries: Entry[] = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const root = parse(path).root;
  const parent = path === root ? null : dirname(path);
  return { path, parent, entries };
}

export function fsRouter(): Router {
  const r = Router();

  r.get('/fs/list', async (req, res) => {
    const raw = typeof req.query['path'] === 'string' ? req.query['path'] : null;
    try {
      const result = await listDirectory(raw);
      res.json(result);
    } catch (err) {
      res
        .status(400)
        .json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  r.get('/fs/home', (_req, res) => {
    res.json({ path: homedir() });
  });

  return r;
}
