import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { isConflicted } from './conflict.js';
import { ConflictError, UnsupportedRestItemError } from './errors.js';
import { encode, decode } from './frontmatter.js';
import { restItemToFrontmatter } from './mapper.js';
import { postFilePath } from './paths.js';
import type { TypedEmitter, SyncEvents } from './events.js';
import type { Config, PostType, RestItem, State } from './types.js';
import type { RestClient } from './rest-client.js';
import type { TaxonomyCache } from './taxonomy-cache.js';

export type ConflictResolution = 'keep-local' | 'keep-server' | 'skip';
export type ConflictResolutions = Record<string, ConflictResolution>;

export interface PullOptions {
  full?: boolean;
  type?: PostType;
  dryRun?: boolean;
  forcePull?: boolean;
  resolutions?: ConflictResolutions;
}

export interface PullDeps {
  rootDir: string;
  config: Config;
  rest: RestClient;
  taxonomy: TaxonomyCache;
  state: State;
  events: TypedEmitter<SyncEvents>;
}

export interface PullResult {
  written: number;
  skipped: number;
  newState: State;
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

async function alignMtime(path: string, modifiedGmt: string): Promise<void> {
  const targetMs = Date.parse(appendZ(modifiedGmt));
  if (!Number.isFinite(targetMs)) return;
  const seconds = targetMs / 1000;
  try {
    await fs.utimes(path, seconds, seconds);
  } catch {
    // utimes may fail on exotic filesystems; not fatal.
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readLocalMeta(path: string): Promise<
  { localModifiedGmt: string; fileMtimeMs: number } | null
> {
  if (!(await fileExists(path))) return null;
  try {
    const stat = await fs.stat(path);
    const text = await fs.readFile(path, 'utf8');
    const { meta } = decode(text);
    return { localModifiedGmt: meta.modified_gmt, fileMtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

interface BufferedItem {
  type: PostType;
  item: RestItem;
}

export async function pull(deps: PullDeps, opts: PullOptions = {}): Promise<PullResult> {
  const { rootDir, config, rest, taxonomy, state, events } = deps;
  const types: PostType[] = opts.type ? [opts.type] : config.enabled_types;
  const modifiedAfter = opts.full || !state.last_sync ? null : appendZ(state.last_sync);

  // Buffer the listing so we can run a conflict pre-pass before any writes.
  const buffered: BufferedItem[] = [];
  for (const type of types) {
    for await (const item of rest.listItems(type, { modifiedAfter })) {
      buffered.push({ type, item });
    }
  }

  const resolutions = opts.resolutions ?? {};
  const conflicts: string[] = [];
  for (const { type, item } of buffered) {
    const path = postFilePath(rootDir, type, item.slug);
    const local = await readLocalMeta(path);
    if (!local) continue;
    if (
      isConflicted({
        serverModifiedGmt: item.modified_gmt,
        localModifiedGmt: local.localModifiedGmt,
        fileMtimeMs: local.fileMtimeMs,
      })
    ) {
      conflicts.push(`${type}/${item.slug}`);
    }
  }

  if (!opts.forcePull) {
    const unresolved = conflicts.filter((slug) => !(slug in resolutions));
    if (unresolved.length > 0) {
      throw new ConflictError(unresolved);
    }
  }
  const conflictSet = new Set(conflicts);

  const total = buffered.length;
  events.emit('start', { op: 'pull', total });

  let written = 0;
  let maxModifiedGmt = state.last_sync;
  let index = 0;

  for (const { type, item } of buffered) {
    const slugKey = `${type}/${item.slug}`;
    const resolution = resolutions[slugKey];

    // Pull only writes when there's no conflict, or when the conflict was resolved
    // in our favour ("keep-server"). 'keep-local' and 'skip' defer to push or no-op.
    const isConflicting = conflictSet.has(slugKey);
    const writeLocal = !isConflicting || opts.forcePull || resolution === 'keep-server';

    let mapped: Awaited<ReturnType<typeof restItemToFrontmatter>>;
    try {
      mapped = await restItemToFrontmatter(item, taxonomy);
    } catch (err) {
      if (err instanceof UnsupportedRestItemError) {
        index += 1;
        events.emit('log', {
          level: 'warn',
          msg: `${slugKey}: ${err.message} Skipping item.`,
        });
        events.emit('item', {
          op: 'pull',
          slug: slugKey,
          index,
          total,
          action: 'skip',
        });
        continue;
      }
      throw err;
    }
    const { meta, body } = mapped;
    const path = postFilePath(rootDir, type, meta.slug);
    const exists = await fileExists(path);
    const baseAction: 'create' | 'update' = exists ? 'update' : 'create';
    const action: 'create' | 'update' | 'skip' = writeLocal ? baseAction : 'skip';

    if (writeLocal && !opts.dryRun) {
      const text = encode(meta, body);
      await atomicWrite(path, text);
      await alignMtime(path, item.modified_gmt);
    }

    if (writeLocal) written += 1;
    index += 1;
    events.emit('item', {
      op: 'pull',
      slug: slugKey,
      index,
      total,
      action,
    });

    if (writeLocal && (!maxModifiedGmt || item.modified_gmt > maxModifiedGmt)) {
      maxModifiedGmt = item.modified_gmt;
    }
  }

  const newState: State = {
    schema_version: 1,
    last_sync: maxModifiedGmt ?? null,
  };

  const skipped = total - written;
  events.emit('done', { op: 'pull', written, skipped });

  return { written, skipped, newState };
}
