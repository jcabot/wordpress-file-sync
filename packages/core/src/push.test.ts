import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push } from './push.js';
import { encode, decode } from './frontmatter.js';
import { TypedEmitter, type SyncEvents } from './events.js';
import { postFilePath, typeDir } from './paths.js';
import type { Config, FrontMatter, RestItem } from './types.js';
import type { RestClient } from './rest-client.js';
import type { TaxonomyCache } from './taxonomy-cache.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-push-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

const taxonomy: TaxonomyCache = {
  async slugById() {
    return null;
  },
  async idBySlug(type, slug) {
    if (type === 'categories' && slug === 'research') return 7;
    return null;
  },
  async refresh() {},
};

const config: Config = {
  site_url: 'https://example.com',
  content_dir: '.',
  enabled_types: ['post', 'page'],
  username: 'alice',
};

function baseMeta(over: Partial<FrontMatter> = {}): FrontMatter {
  return {
    id: 1,
    type: 'post',
    slug: 'hello',
    title: 'Hello',
    status: 'publish',
    categories: ['research'],
    tags: [],
    featured_media: 0,
    excerpt: '',
    date_gmt: '2025-01-01T00:00:00',
    modified_gmt: '2025-01-02T00:00:00',
    ...over,
  };
}

async function writePostFile(
  meta: FrontMatter,
  body: string,
  mtimeMs: number,
): Promise<string> {
  const path = postFilePath(root, meta.type, meta.slug);
  const dir = typeDir(root, meta.type);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, encode(meta, body), 'utf8');
  const seconds = mtimeMs / 1000;
  await fs.utimes(path, seconds, seconds);
  return path;
}

function fakeRest(over: Partial<RestClient> = {}): RestClient {
  return {
    listItems: () => (async function* () {})(),
    countItems: async () => 0,
    listTaxonomy: () => (async function* () {})(),
    getMe: async () => ({ id: 0, slug: '' }),
    createItem: async () => {
      throw new Error('createItem not stubbed');
    },
    updateItem: async () => {
      throw new Error('updateItem not stubbed');
    },
    deleteItem: async () => {
      throw new Error('deleteItem not stubbed');
    },
    getItem: async () => {
      throw new Error('getItem not stubbed');
    },
    ...over,
  };
}

function baseRestItem(over: Partial<RestItem> = {}): RestItem {
  return {
    id: 1,
    type: 'post',
    slug: 'hello',
    status: 'publish',
    date_gmt: '2025-01-01T00:00:00',
    modified_gmt: '2025-01-02T00:00:00',
    title: { raw: 'Hello', rendered: '' },
    content: { raw: '', rendered: '' },
    excerpt: { raw: '', rendered: '' },
    categories: [7],
    tags: [],
    featured_media: 0,
    ...over,
  };
}

function makeEvents() {
  const events = new TypedEmitter<SyncEvents>();
  const items: SyncEvents['item'][] = [];
  events.on('item', (e) => items.push(e));
  return { events, items };
}

describe('push', () => {
  it('skips files when local mtime is not newer than modified_gmt', async () => {
    // mtime equal to modified_gmt in ms — within tolerance.
    const meta = baseMeta({ modified_gmt: '2025-01-02T00:00:00' });
    const mtimeMs = Date.parse('2025-01-02T00:00:00Z');
    await writePostFile(meta, '<p>body</p>', mtimeMs);

    const rest = fakeRest();
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post' },
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(items[0]?.action).toBe('skip');
  });

  it('updates a post when mtime is well beyond the 2s tolerance', async () => {
    const meta = baseMeta({ modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z'); // 10s ahead
    await writePostFile(meta, '<p>edited body</p>', localMtime);

    const updateItem = vi.fn(async (_type, _id, _payload) => ({
      id: 1,
      type: 'post',
      slug: 'hello',
      status: 'publish',
      date_gmt: '2025-01-01T00:00:00',
      modified_gmt: '2025-04-01T12:00:00',
      title: { raw: 'Hello', rendered: '' },
      content: { raw: '<p>edited body</p>', rendered: '' },
      excerpt: { raw: '', rendered: '' },
      categories: [7],
      tags: [],
      featured_media: 0,
    }) as unknown as RestItem);

    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-01-02T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post' },
    );
    expect(result.written).toBe(1);
    expect(items[0]?.action).toBe('update');
    expect(updateItem).toHaveBeenCalledWith(
      'post',
      1,
      expect.objectContaining({
        title: 'Hello',
        content: '<p>edited body</p>',
        categories: [7],
      }),
    );

    // Front-matter should have the new modified_gmt written back.
    const path = postFilePath(root, 'post', 'hello');
    const written = decode(await fs.readFile(path, 'utf8'));
    expect(written.meta.modified_gmt).toBe('2025-04-01T12:00:00');
  });

  it('creates a post when meta.id is missing and writes the assigned id back', async () => {
    const meta = baseMeta({ id: undefined as unknown as number, slug: 'brand-new' });
    delete (meta as Partial<FrontMatter>).id;
    await writePostFile(meta as FrontMatter, '<p>fresh</p>', Date.now());

    const createItem = vi.fn(async () => ({
      id: 999,
      type: 'post',
      slug: 'brand-new',
      status: 'publish',
      date_gmt: '2025-01-01T00:00:00',
      modified_gmt: '2025-04-26T10:00:00',
      title: { raw: 'Hello', rendered: '' },
      content: { raw: '<p>fresh</p>', rendered: '' },
      excerpt: { raw: '', rendered: '' },
      categories: [7],
      tags: [],
      featured_media: 0,
    }) as unknown as RestItem);

    const rest = fakeRest({ createItem: createItem as RestClient['createItem'] });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post' },
    );
    expect(result.written).toBe(1);
    expect(items[0]?.action).toBe('create');
    expect(createItem).toHaveBeenCalledTimes(1);

    const path = postFilePath(root, 'post', 'brand-new');
    const { meta: writtenMeta } = decode(await fs.readFile(path, 'utf8'));
    expect(writtenMeta.id).toBe(999);
    expect(writtenMeta.modified_gmt).toBe('2025-04-26T10:00:00');
  });

  it('makes a subsequent push a no-op (mtime aligned to server modified_gmt)', async () => {
    const meta = baseMeta();
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>edited</p>', localMtime);

    const updateItem = vi.fn(async () => ({
      id: 1,
      type: 'post',
      slug: 'hello',
      status: 'publish',
      date_gmt: '2025-01-01T00:00:00',
      modified_gmt: '2025-04-01T12:00:00',
      title: { raw: 'Hello', rendered: '' },
      content: { raw: '<p>edited</p>', rendered: '' },
      excerpt: { raw: '', rendered: '' },
      categories: [7],
      tags: [],
      featured_media: 0,
    }) as unknown as RestItem);

    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-01-02T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events: events1 } = makeEvents();
    await push({ rootDir: root, config, rest, taxonomy, events: events1 }, { type: 'post' });

    const { events: events2, items: items2 } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events: events2 },
      { type: 'post' },
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(items2[0]?.action).toBe('skip');
    expect(updateItem).toHaveBeenCalledTimes(1);
  });

  it('dry run emits item events but does not POST or write back', async () => {
    const meta = baseMeta();
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>edited</p>', localMtime);

    const updateItem = vi.fn();
    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-01-02T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post', dryRun: true },
    );
    expect(result.written).toBe(1);
    expect(items[0]?.action).toBe('update');
    expect(updateItem).not.toHaveBeenCalled();

    // File still has the old modified_gmt, mtime unchanged.
    const path = postFilePath(root, 'post', 'hello');
    const { meta: still } = decode(await fs.readFile(path, 'utf8'));
    expect(still.modified_gmt).toBe('2025-01-02T00:00:00');
  });

  it('status: trash + id → DELETE (no force) and remove the local file', async () => {
    const meta = baseMeta({ status: 'trash', id: 42 });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    const path = await writePostFile(meta, '<p>doomed</p>', localMtime);

    const deleteItem = vi.fn(async () => {});
    const rest = fakeRest({ deleteItem: deleteItem as RestClient['deleteItem'] });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post' },
    );
    expect(result.written).toBe(1);
    expect(items[0]?.action).toBe('delete');
    expect(deleteItem).toHaveBeenCalledWith('post', 42);
    await expect(fs.access(path)).rejects.toThrow();
  });

  it('status: trash without id only removes the local file (no API call)', async () => {
    const meta = baseMeta({ status: 'trash', id: undefined as unknown as number, slug: 'never-saved' });
    delete (meta as Partial<FrontMatter>).id;
    const path = await writePostFile(meta as FrontMatter, '<p>draft</p>', Date.now());

    const deleteItem = vi.fn();
    const rest = fakeRest({ deleteItem: deleteItem as RestClient['deleteItem'] });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post' },
    );
    expect(result.written).toBe(1);
    expect(items[0]?.action).toBe('delete');
    expect(deleteItem).not.toHaveBeenCalled();
    await expect(fs.access(path)).rejects.toThrow();
  });

  it('halts with ConflictError when both sides have changed', async () => {
    const meta = baseMeta({ id: 1, modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>local edit</p>', localMtime);
    // state.json says we last synced at meta.modified_gmt
    const { promises: fsp } = await import('node:fs');
    await fsp.mkdir(join(root, '.wpsync'), { recursive: true });
    await fsp.writeFile(
      join(root, '.wpsync', 'state.json'),
      JSON.stringify({ schema_version: 1, last_sync: '2025-01-02T00:00:00' }),
    );

    const updateItem = vi.fn();
    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-04-01T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events } = makeEvents();
    const { ConflictError } = await import('./errors.js');
    await expect(
      push({ rootDir: root, config, rest, taxonomy, events }, { type: 'post' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('resolutions: "keep-local" lets push overwrite the server for that slug', async () => {
    const meta = baseMeta({ id: 1, modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>local wins</p>', localMtime);

    const updateItem = vi.fn(async () => ({
      id: 1,
      type: 'post',
      slug: 'hello',
      status: 'publish',
      date_gmt: '2025-01-01T00:00:00',
      modified_gmt: '2025-05-01T00:00:00',
      title: { raw: 'Hello', rendered: '' },
      content: { raw: '<p>local wins</p>', rendered: '' },
      excerpt: { raw: '', rendered: '' },
      categories: [7],
      tags: [],
      featured_media: 0,
    }) as unknown as RestItem);

    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-04-01T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post', resolutions: { 'post/hello': 'keep-local' } },
    );
    expect(result.written).toBe(1);
    expect(updateItem).toHaveBeenCalled();
  });

  it('resolutions: "keep-server" makes push skip a conflicting slug', async () => {
    const meta = baseMeta({ id: 1, modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>local edit</p>', localMtime);

    const updateItem = vi.fn();
    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-04-01T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events, items } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post', resolutions: { 'post/hello': 'keep-server' } },
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(items[0]?.action).toBe('skip');
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('--force-push bypasses the conflict halt and overwrites the server', async () => {
    const meta = baseMeta({ id: 1, modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    await writePostFile(meta, '<p>local edit</p>', localMtime);

    const updateItem = vi.fn(async () => ({
      id: 1,
      type: 'post',
      slug: 'hello',
      status: 'publish',
      date_gmt: '2025-01-01T00:00:00',
      modified_gmt: '2025-05-01T00:00:00',
      title: { raw: 'Hello', rendered: '' },
      content: { raw: '<p>local edit</p>', rendered: '' },
      excerpt: { raw: '', rendered: '' },
      categories: [7],
      tags: [],
      featured_media: 0,
    }) as unknown as RestItem);

    const rest = fakeRest({
      // listItems would surface server-side change but force flag should skip the check
      listItems: () =>
        (async function* () {
          yield {
            id: 1,
            type: 'post',
            slug: 'hello',
            status: 'publish',
            date_gmt: '2025-01-01T00:00:00',
            modified_gmt: '2025-04-01T00:00:00',
            title: { raw: 'Hello', rendered: '' },
            content: { raw: '', rendered: '' },
            excerpt: { raw: '', rendered: '' },
            categories: [7],
            tags: [],
            featured_media: 0,
          } as RestItem;
        })(),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events } = makeEvents();
    const result = await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'post', forcePush: true },
    );
    expect(result.written).toBe(1);
    expect(updateItem).toHaveBeenCalled();
  });

  it('skips files whose mtime changed since collection (race guard)', async () => {
    const meta = baseMeta({ id: 1, modified_gmt: '2025-01-02T00:00:00' });
    const localMtime = Date.parse('2025-01-02T00:00:10Z');
    const path = await writePostFile(meta, '<p>edit</p>', localMtime);

    const updateItem = vi.fn();
    const rest = fakeRest({
      getItem: async () => ({ ...baseRestItem(), modified_gmt: '2025-01-02T00:00:00' }),
      updateItem: updateItem as RestClient['updateItem'],
    });
    const { events, items } = makeEvents();

    // Bump the file's mtime AFTER collectCandidates runs — but since collect
    // and the loop are in one push() call, we patch fs.stat to return a
    // different mtime on the second call (the race guard).
    const realStat = (await import('node:fs')).promises.stat;
    const fsp = (await import('node:fs')).promises;
    let calls = 0;
    const spy = vi.spyOn(fsp, 'stat').mockImplementation(async (p: Parameters<typeof realStat>[0]) => {
      const result = await realStat(p);
      calls += 1;
      if (calls === 2 && String(p) === path) {
        return { ...result, mtimeMs: result.mtimeMs + 5_000 } as typeof result;
      }
      return result;
    });

    try {
      const result = await push(
        { rootDir: root, config, rest, taxonomy, events },
        { type: 'post' },
      );
      expect(result.skipped).toBe(1);
      expect(result.written).toBe(0);
      expect(items[0]?.action).toBe('skip');
      expect(updateItem).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('--type filter restricts to one type', async () => {
    const post = baseMeta({ slug: 'p1' });
    const page = baseMeta({ id: undefined as unknown as number, type: 'page', slug: 'pg1' });
    delete (page as Partial<FrontMatter>).id;
    await writePostFile(post, '<p>body</p>', Date.now());
    await writePostFile(page as FrontMatter, '<p>body</p>', Date.now());

    const updateItem = vi.fn();
    const createItem = vi.fn();
    const rest = fakeRest({
      updateItem: updateItem as RestClient['updateItem'],
      createItem: createItem as RestClient['createItem'],
    });
    const { events } = makeEvents();
    await push(
      { rootDir: root, config, rest, taxonomy, events },
      { type: 'page', dryRun: true },
    );
    expect(updateItem).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
  });
});
