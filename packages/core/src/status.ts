import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isConflicted, localChanged } from './conflict.js';
import { decode } from './frontmatter.js';
import { typeDir } from './paths.js';
import type { Config, FrontMatter, PostType, State } from './types.js';
import type { RestClient } from './rest-client.js';

export type EntryState =
  | 'up-to-date'
  | 'pending-pull'
  | 'pending-push'
  | 'conflict'
  | 'tombstone'
  | 'new-local';

export interface StatusEntry {
  type: PostType;
  slug: string;
  state: EntryState;
}

export interface StatusResult {
  lastSync: string | null;
  entries: StatusEntry[];
  byCategory: {
    pendingPull: StatusEntry[];
    pendingPush: StatusEntry[];
    conflict: StatusEntry[];
    tombstone: StatusEntry[];
    newLocal: StatusEntry[];
    upToDate: StatusEntry[];
  };
}

export interface StatusDeps {
  rootDir: string;
  config: Config;
  rest: RestClient;
  state: State;
}

export interface StatusOptions {
  type?: PostType;
}

function appendZ(s: string): string {
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
}

interface LocalEntry {
  type: PostType;
  slug: string;
  meta: FrontMatter;
  fileMtimeMs: number;
}

async function walkLocal(rootDir: string, types: PostType[]): Promise<LocalEntry[]> {
  const out: LocalEntry[] = [];
  for (const type of types) {
    const dir = typeDir(rootDir, type);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    entries.sort();
    for (const name of entries) {
      if (!name.endsWith('.html')) continue;
      const path = join(dir, name);
      const stat = await fs.stat(path);
      const text = await fs.readFile(path, 'utf8');
      const { meta } = decode(text);
      out.push({ type, slug: meta.slug, meta, fileMtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

interface ServerEntry {
  type: PostType;
  slug: string;
  modifiedGmt: string;
}

async function fetchServerChanges(
  rest: RestClient,
  types: PostType[],
  state: State,
): Promise<ServerEntry[]> {
  const out: ServerEntry[] = [];
  const modifiedAfter = state.last_sync ? appendZ(state.last_sync) : null;
  for (const type of types) {
    for await (const item of rest.listItems(type, { modifiedAfter })) {
      out.push({ type, slug: item.slug, modifiedGmt: item.modified_gmt });
    }
  }
  return out;
}

export async function status(deps: StatusDeps, opts: StatusOptions = {}): Promise<StatusResult> {
  const { rootDir, config, rest, state } = deps;
  const types: PostType[] = opts.type ? [opts.type] : config.enabled_types;

  const [locals, serverChanges] = await Promise.all([
    walkLocal(rootDir, types),
    fetchServerChanges(rest, types, state),
  ]);

  const serverMap = new Map<string, string>();
  for (const s of serverChanges) {
    serverMap.set(`${s.type}/${s.slug}`, s.modifiedGmt);
  }

  const localKeys = new Set<string>();
  const entries: StatusEntry[] = [];

  for (const local of locals) {
    const key = `${local.type}/${local.slug}`;
    localKeys.add(key);

    if (local.meta.status === 'trash') {
      entries.push({ type: local.type, slug: local.slug, state: 'tombstone' });
      continue;
    }
    if (local.meta.id === undefined) {
      entries.push({ type: local.type, slug: local.slug, state: 'new-local' });
      continue;
    }

    const serverMod = serverMap.get(key);
    const wasLocallyChanged = localChanged(local.fileMtimeMs, local.meta.modified_gmt);

    if (serverMod && wasLocallyChanged) {
      const conflicted = isConflicted({
        serverModifiedGmt: serverMod,
        localModifiedGmt: local.meta.modified_gmt,
        fileMtimeMs: local.fileMtimeMs,
      });
      entries.push({
        type: local.type,
        slug: local.slug,
        state: conflicted ? 'conflict' : 'pending-push',
      });
      continue;
    }
    if (serverMod) {
      entries.push({ type: local.type, slug: local.slug, state: 'pending-pull' });
      continue;
    }
    if (wasLocallyChanged) {
      entries.push({ type: local.type, slug: local.slug, state: 'pending-push' });
      continue;
    }
    entries.push({ type: local.type, slug: local.slug, state: 'up-to-date' });
  }

  // Server-side items that don't exist locally are pending pulls (new on server).
  for (const s of serverChanges) {
    const key = `${s.type}/${s.slug}`;
    if (!localKeys.has(key)) {
      entries.push({ type: s.type, slug: s.slug, state: 'pending-pull' });
    }
  }

  const byCategory: StatusResult['byCategory'] = {
    pendingPull: entries.filter((e) => e.state === 'pending-pull'),
    pendingPush: entries.filter((e) => e.state === 'pending-push'),
    conflict: entries.filter((e) => e.state === 'conflict'),
    tombstone: entries.filter((e) => e.state === 'tombstone'),
    newLocal: entries.filter((e) => e.state === 'new-local'),
    upToDate: entries.filter((e) => e.state === 'up-to-date'),
  };

  return { lastSync: state.last_sync, entries, byCategory };
}
