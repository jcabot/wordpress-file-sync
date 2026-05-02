import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { isConflicted, localChanged } from './conflict.js';
import { ConflictError } from './errors.js';
import { decode, encode } from './frontmatter.js';
import { frontmatterToPayload } from './mapper.js';
import { typeDir } from './paths.js';
import { loadState, saveState } from './state.js';
import type { Config, FrontMatter, PostType, RestItem } from './types.js';
import type { RestClient } from './rest-client.js';
import type { TaxonomyCache } from './taxonomy-cache.js';
import type { SyncEvents, TypedEmitter } from './events.js';

export type ConflictResolution = 'keep-local' | 'keep-server' | 'skip';
export type ConflictResolutions = Record<string, ConflictResolution>;

export interface PushOptions {
  type?: PostType;
  dryRun?: boolean;
  forcePush?: boolean;
  resolutions?: ConflictResolutions;
}

export interface PushDeps {
  rootDir: string;
  config: Config;
  rest: RestClient;
  taxonomy: TaxonomyCache;
  events: TypedEmitter<SyncEvents>;
}

export interface PushResult {
  written: number;
  skipped: number;
}

function appendZ(s: string): string {
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, path);
}

interface Candidate {
  type: PostType;
  path: string;
  meta: FrontMatter;
  body: string;
  fileMtimeMs: number;
}

async function collectCandidates(rootDir: string, types: PostType[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
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
      const { meta, body } = decode(text);
      out.push({ type, path, meta, body, fileMtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

type Action = 'create' | 'update' | 'skip' | 'delete';

function classify(candidate: Candidate): Action {
  if (candidate.meta.status === 'trash') return 'delete';
  if (candidate.meta.id === undefined) return 'create';
  if (localChanged(candidate.fileMtimeMs, candidate.meta.modified_gmt)) return 'update';
  return 'skip';
}

async function fetchServerMods(
  rest: RestClient,
  candidates: Candidate[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for (const c of candidates) {
    const id = c.meta.id;
    if (id === undefined) continue;
    if (c.meta.status === 'trash') continue;
    if (!localChanged(c.fileMtimeMs, c.meta.modified_gmt)) continue;
    const item = await rest.getItem(c.type, id);
    map.set(id, item.modified_gmt);
  }
  return map;
}

function detectConflicts(
  candidates: Candidate[],
  serverMods: Map<number, string>,
): string[] {
  const conflicts: string[] = [];
  for (const c of candidates) {
    const id = c.meta.id;
    if (id === undefined) continue;
    if (c.meta.status === 'trash') continue;
    if (!localChanged(c.fileMtimeMs, c.meta.modified_gmt)) continue;
    const serverMod = serverMods.get(id);
    if (!serverMod) continue;
    if (
      isConflicted({
        serverModifiedGmt: serverMod,
        localModifiedGmt: c.meta.modified_gmt,
        fileMtimeMs: c.fileMtimeMs,
      })
    ) {
      conflicts.push(`${c.type}/${c.meta.slug}`);
    }
  }
  return conflicts;
}

async function writeBack(candidate: Candidate, response: RestItem): Promise<void> {
  const updated: FrontMatter = {
    ...candidate.meta,
    id: response.id,
    modified_gmt: response.modified_gmt,
  };
  const text = encode(updated, candidate.body);
  await atomicWrite(candidate.path, text);
  const targetMs = Date.parse(appendZ(response.modified_gmt));
  if (Number.isFinite(targetMs)) {
    const seconds = targetMs / 1000;
    try {
      await fs.utimes(candidate.path, seconds, seconds);
    } catch {
      // utimes may fail on exotic filesystems; not fatal.
    }
  }
}

export async function push(deps: PushDeps, opts: PushOptions = {}): Promise<PushResult> {
  const { rootDir, config, rest, taxonomy, events } = deps;
  const types: PostType[] = opts.type ? [opts.type] : config.enabled_types;

  const candidates = await collectCandidates(rootDir, types);

  const resolutions = opts.resolutions ?? {};
  let conflictSet = new Set<string>();

  // Conflict detection — only if there are id'd candidates that are locally newer.
  const needConflictCheck = candidates.some(
    (c) =>
      c.meta.id !== undefined &&
      c.meta.status !== 'trash' &&
      localChanged(c.fileMtimeMs, c.meta.modified_gmt),
  );

  if (needConflictCheck) {
    const serverMods = await fetchServerMods(rest, candidates);
    const conflicts = detectConflicts(candidates, serverMods);
    conflictSet = new Set(conflicts);
    if (!opts.forcePush) {
      const unresolved = conflicts.filter((slug) => !(slug in resolutions));
      if (unresolved.length > 0) {
        throw new ConflictError(unresolved);
      }
    }
  }

  const total = candidates.length;
  events.emit('start', { op: 'push', total });

  let written = 0;
  let skipped = 0;
  let index = 0;

  for (const candidate of candidates) {
    let action = classify(candidate);
    index += 1;
    const slug = `${candidate.type}/${candidate.meta.slug}`;

    // Push only sends when there's no conflict, or when the conflict was resolved
    // in our favour ("keep-local"). 'keep-server' and 'skip' defer to pull or no-op.
    const isConflicting = conflictSet.has(slug);
    if (isConflicting && !opts.forcePush) {
      const resolution = resolutions[slug];
      if (resolution !== 'keep-local') {
        action = 'skip';
      }
    }

    // Race guard: re-stat the file just before sending. If it changed since we
    // read it, an editor may be mid-save and our "newer than server" snapshot
    // is stale. Skip and let the user re-run.
    if (action === 'create' || action === 'update' || action === 'delete') {
      try {
        const fresh = await fs.stat(candidate.path);
        if (fresh.mtimeMs !== candidate.fileMtimeMs) {
          events.emit('log', {
            level: 'warn',
            msg: `${slug}: file mtime changed during push (editor open?) — skipping. Re-run to retry.`,
          });
          action = 'skip';
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          events.emit('log', {
            level: 'warn',
            msg: `${slug}: file removed during push — skipping.`,
          });
          action = 'skip';
        } else {
          throw err;
        }
      }
    }

    events.emit('item', { op: 'push', slug, index, total, action });

    if (action === 'skip') {
      skipped += 1;
      continue;
    }

    if (opts.dryRun) {
      written += 1;
      continue;
    }

    if (action === 'delete') {
      if (candidate.meta.id !== undefined) {
        await rest.deleteItem(candidate.type, candidate.meta.id);
      }
      await fs.unlink(candidate.path);
      written += 1;
      continue;
    }

    const payload = await frontmatterToPayload(candidate.meta, candidate.body, taxonomy);
    let response: RestItem;
    if (action === 'create') {
      response = await rest.createItem(candidate.type, payload);
    } else {
      const id = candidate.meta.id;
      if (id === undefined) throw new Error(`push: id missing for update on ${slug}`);
      response = await rest.updateItem(candidate.type, id, payload);
    }
    await writeBack(candidate, response);
    written += 1;
  }

  // Bump last_sync past anything we just pushed so the next pull doesn't re-pull our own writes.
  if (!opts.dryRun && written > 0) {
    const state = await loadState(rootDir);
    let maxModifiedGmt = state.last_sync;
    for (const c of candidates) {
      const m = c.meta.modified_gmt;
      if (!maxModifiedGmt || m > maxModifiedGmt) maxModifiedGmt = m;
    }
    if (maxModifiedGmt && maxModifiedGmt !== state.last_sync) {
      await saveState(rootDir, { schema_version: 1, last_sync: maxModifiedGmt });
    }
  }

  events.emit('done', { op: 'push', written, skipped });

  return { written, skipped };
}
