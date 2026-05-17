import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { appendZ, isConflicted, localChanged } from './conflict.js';
import { ConflictError, UnsupportedRestItemError } from './errors.js';
import { encode, decode } from './frontmatter.js';
import { restItemToFrontmatter } from './mapper.js';
import { postFilePath, slugKey } from './paths.js';
import type { TypedEmitter, SyncEvents } from './events.js';
import type { Config, FrontMatter, PostType, RestItem, State } from './types.js';
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

async function readLocalMeta(
  path: string,
): Promise<{ meta: FrontMatter; fileMtimeMs: number } | null> {
  if (!(await fileExists(path))) return null;
  try {
    const stat = await fs.stat(path);
    const text = await fs.readFile(path, 'utf8');
    const { meta } = decode(text);
    return { meta, fileMtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

interface BufferedItem {
  type: PostType;
  item: RestItem;
}

interface TrashedDeletion {
  type: PostType;
  item: RestItem;
  path: string;
  slug: string;
}

export async function pull(deps: PullDeps, opts: PullOptions = {}): Promise<PullResult> {
  const { rootDir, config, rest, taxonomy, state, events } = deps;
  const types: PostType[] = opts.type ? [opts.type] : config.enabled_types;
  const modifiedAfter = opts.full || !state.last_sync ? null : appendZ(state.last_sync);

  // Buffer the listing so we can run a conflict pre-pass before any writes.
  const buffered: BufferedItem[] = [];
  const deletions: TrashedDeletion[] = [];
  const deletionConflictSet = new Set<string>();
  for (const type of types) {
    let listed = 0;
    events.emit('log', {
      level: 'info',
      msg: `Fetching published ${type === 'post' ? 'posts' : 'pages'} from WordPress...`,
    });
    for await (const item of rest.listItems(type, {
      modifiedAfter,
      onPage(page) {
        if (page.skipped) {
          events.emit('log', {
            level: 'warn',
            msg: `Skipped malformed WordPress REST page ${page.page} while fetching ${type === 'post' ? 'posts' : 'pages'}. Continuing with the next page.`,
          });
          return;
        }
        listed += page.items;
        if (page.items > 0 && (page.page === 1 || page.page % 5 === 0)) {
          const total = page.totalPages ? `/${page.totalPages}` : '';
          events.emit('log', {
            level: 'info',
            msg: `Fetched ${listed} ${type === 'post' ? 'post' : 'page'} item(s) so far (REST page ${page.page}${total}).`,
          });
        }
      },
    })) {
      buffered.push({ type, item });
    }
    if (listed === 0 && modifiedAfter) {
      events.emit('log', {
        level: 'info',
        msg: `No published ${type === 'post' ? 'posts' : 'pages'} changed since the last sync.`,
      });
    }
    events.emit('log', {
      level: 'info',
      msg: `Finished fetching ${listed} ${type === 'post' ? 'post' : 'page'} item(s).`,
    });

    // Trashes resolve to deletion candidates in the same pass. Force-deleted
    // posts (never appear in REST) are an accepted gap.
    let trashedCount = 0;
    for await (const item of rest.listItems(type, {
      modifiedAfter,
      status: 'trash',
      onPage(page) {
        if (page.skipped) {
          events.emit('log', {
            level: 'warn',
            msg: `Skipped malformed WordPress REST page ${page.page} while fetching trashed ${type === 'post' ? 'posts' : 'pages'}. Continuing with the next page.`,
          });
        }
      },
    })) {
      trashedCount += 1;
      // WP's `_wp_post_name_for_trashed_posts` filter renames `<slug>` to
      // `<slug>__trashed` for any trashed post type (posts AND pages), so the
      // listing reports the suffixed name. The local file still uses the original.
      const localSlug = item.slug.replace(/__trashed$/, '');
      const path = postFilePath(rootDir, type, localSlug);
      const local = await readLocalMeta(path);
      if (!local) continue;
      // Same slug with a different id is a different (live) post — don't touch it.
      if (local.meta.id !== item.id) continue;
      // Local already-tombstoned: push owns the cleanup, don't double-act.
      if (local.meta.status === 'trash') continue;
      const key = slugKey(type, localSlug);
      if (localChanged(local.fileMtimeMs, local.meta.modified_gmt)) {
        deletionConflictSet.add(key);
      }
      deletions.push({ type, item, path, slug: localSlug });
    }
    if (trashedCount > 0) {
      events.emit('log', {
        level: 'info',
        msg: `Found ${trashedCount} trashed ${type === 'post' ? 'post' : 'page'} item(s) on the server.`,
      });
    }
  }

  const resolutions = opts.resolutions ?? {};
  const conflictSet = new Set<string>(deletionConflictSet);
  for (const { type, item } of buffered) {
    const path = postFilePath(rootDir, type, item.slug);
    const local = await readLocalMeta(path);
    if (!local) continue;
    if (
      isConflicted({
        serverModifiedGmt: item.modified_gmt,
        localModifiedGmt: local.meta.modified_gmt,
        fileMtimeMs: local.fileMtimeMs,
      })
    ) {
      conflictSet.add(slugKey(type, item.slug));
    }
  }

  if (!opts.forcePull) {
    const unresolved = [...conflictSet].filter((slug) => !(slug in resolutions));
    if (unresolved.length > 0) {
      throw new ConflictError(unresolved);
    }
  }

  const total = buffered.length + deletions.length;
  events.emit('start', { op: 'pull', total });

  let written = 0;
  let maxModifiedGmt = state.last_sync;
  let index = 0;

  for (const { type, item } of buffered) {
    const key = slugKey(type, item.slug);
    const resolution = resolutions[key];

    // Pull writes when no conflict, or when resolved in our favour ("keep-server").
    const isConflicting = conflictSet.has(key);
    const writeLocal = !isConflicting || opts.forcePull || resolution === 'keep-server';

    let mapped: Awaited<ReturnType<typeof restItemToFrontmatter>>;
    try {
      mapped = await restItemToFrontmatter(item, taxonomy);
    } catch (err) {
      if (err instanceof UnsupportedRestItemError) {
        index += 1;
        events.emit('log', {
          level: 'warn',
          msg: `${key}: ${err.message} Skipping item.`,
        });
        events.emit('item', {
          op: 'pull',
          slug: key,
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
      slug: key,
      index,
      total,
      action,
    });

    if (writeLocal && (!maxModifiedGmt || item.modified_gmt > maxModifiedGmt)) {
      maxModifiedGmt = item.modified_gmt;
    }
  }

  for (const { type, item, path, slug } of deletions) {
    const key = slugKey(type, slug);
    const resolution = resolutions[key];
    const isConflicting = deletionConflictSet.has(key);
    const deleteLocal =
      !isConflicting || opts.forcePull || resolution === 'keep-server';

    index += 1;

    if (deleteLocal) {
      if (!opts.dryRun) {
        try {
          await fs.unlink(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      written += 1;
      events.emit('item', {
        op: 'pull',
        slug: key,
        index,
        total,
        action: 'delete',
      });
      events.emit('log', {
        level: 'info',
        msg: `${key}: removed locally (server post was trashed).`,
      });
    } else {
      events.emit('item', {
        op: 'pull',
        slug: key,
        index,
        total,
        action: 'skip',
      });
      events.emit('log', {
        level: 'warn',
        msg: `${key}: kept local file — server post is in trash. Un-trash it in WP admin, or clear \`id\` in the front-matter to detach this file.`,
      });
    }

    // Advance last_sync even when we kept the file — the user has been told once.
    if (!maxModifiedGmt || item.modified_gmt > maxModifiedGmt) {
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
