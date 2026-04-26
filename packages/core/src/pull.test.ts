import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pull } from './pull.js';
import { TypedEmitter, type SyncEvents } from './events.js';
import { decode } from './frontmatter.js';
import { postFilePath } from './paths.js';
import type { Config, RestItem, State } from './types.js';
import type { RestClient } from './rest-client.js';
import type { TaxonomyCache } from './taxonomy-cache.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-pull-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

const taxonomy: TaxonomyCache = {
  async slugById(type, id) {
    if (type === 'categories' && id === 7) return 'research';
    if (type === 'tags' && id === 9) return 'besser';
    return null;
  },
  async idBySlug() {
    return null;
  },
  async refresh() {},
};

function makeItem(over: Partial<RestItem> = {}): RestItem {
  return {
    id: 1,
    type: 'post',
    slug: 'hello',
    status: 'publish',
    date_gmt: '2025-01-10T10:00:00',
    modified_gmt: '2025-04-22T15:30:00',
    title: { raw: 'Hello', rendered: '' },
    content: { raw: '<p>verbatim</p>', rendered: '' },
    excerpt: { raw: '', rendered: '' },
    categories: [7],
    tags: [9],
    featured_media: 0,
    ...over,
  };
}

function fakeRest(itemsByType: { post?: RestItem[]; page?: RestItem[] }): RestClient {
  return {
    listItems: (type, _opts) =>
      (async function* () {
        for (const item of itemsByType[type] ?? []) yield item;
      })(),
    countItems: async (type) => (itemsByType[type] ?? []).length,
    listTaxonomy: () => (async function* () {})(),
    getMe: async () => ({ id: 0, slug: '' }),
  };
}

const config: Config = {
  site_url: 'https://example.com',
  content_dir: '.',
  enabled_types: ['post', 'page'],
  username: 'alice',
};

const emptyState: State = { schema_version: 1, last_sync: null };

describe('pull', () => {
  it('writes a post file with verbatim body and front-matter', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item = makeItem({
      id: 42,
      slug: 'first-post',
      content: { raw: '<!-- wp:p --><p>hi</p><!-- /wp:p -->', rendered: '' },
    });
    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [item] }),
        taxonomy,
        state: emptyState,
        events,
      },
      {},
    );
    expect(result.written).toBe(1);
    const path = postFilePath(root, 'post', 'first-post');
    const text = await fs.readFile(path, 'utf8');
    const { meta, body } = decode(text);
    expect(meta.id).toBe(42);
    expect(meta.title).toBe('Hello');
    expect(body).toBe('<!-- wp:p --><p>hi</p><!-- /wp:p -->');
  });

  it('advances last_sync to the max modified_gmt seen', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const items = [
      makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' }),
      makeItem({ id: 2, slug: 'b', modified_gmt: '2025-03-15T12:00:00' }),
      makeItem({ id: 3, slug: 'c', modified_gmt: '2025-02-20T08:00:00' }),
    ];
    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: items }),
        taxonomy,
        state: emptyState,
        events,
      },
      {},
    );
    expect(result.newState.last_sync).toBe('2025-03-15T12:00:00');
  });

  it('emits create for new files and update for existing ones', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const seenActions: string[] = [];
    events.on('item', (e) => seenActions.push(`${e.slug}:${e.action}`));
    const items = [makeItem({ id: 1, slug: 'a' })];

    await pull(
      { rootDir: root, config, rest: fakeRest({ post: items }), taxonomy, state: emptyState, events },
      {},
    );
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: items }), taxonomy, state: emptyState, events },
      {},
    );
    expect(seenActions).toEqual(['post/a:create', 'post/a:update']);
  });

  it('dryRun does not write files but emits events', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const items = [makeItem({ slug: 'dry' })];
    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    const result = await pull(
      { rootDir: root, config, rest: fakeRest({ post: items }), taxonomy, state: emptyState, events },
      { dryRun: true },
    );
    expect(result.written).toBe(1);
    expect(itemEvents.length).toBe(1);
    await expect(fs.access(postFilePath(root, 'post', 'dry'))).rejects.toThrow();
  });

  it('--type filter restricts to one type', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({
          post: [makeItem({ slug: 'p1' })],
          page: [makeItem({ id: 99, type: 'page', slug: 'pg1', parent: 0 })],
        }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'page' },
    );
    expect(result.written).toBe(1);
    await expect(fs.access(postFilePath(root, 'page', 'pg1'))).resolves.toBeUndefined();
    await expect(fs.access(postFilePath(root, 'post', 'p1'))).rejects.toThrow();
  });

  it('aligns mtime to server modified_gmt so an immediate push is a no-op', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item = makeItem({ slug: 'aligned', modified_gmt: '2025-04-22T15:30:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const stat = await fs.stat(postFilePath(root, 'post', 'aligned'));
    const expectedMs = Date.parse('2025-04-22T15:30:00Z');
    // Allow 1s of rounding slack from filesystem mtime granularity.
    expect(Math.abs(stat.mtimeMs - expectedMs)).toBeLessThan(1500);
  });

  it('halts with ConflictError when local has been edited and server has changed', async () => {
    const events = new TypedEmitter<SyncEvents>();
    // Seed a local file via an initial pull, then bump its mtime to simulate a local edit.
    const item1 = makeItem({ id: 1, slug: 'contested', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'contested');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    // Server has also moved on.
    const item2 = makeItem({ id: 1, slug: 'contested', modified_gmt: '2025-04-01T00:00:00' });
    const stateAfterFirst: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const { ConflictError } = await import('./errors.js');
    await expect(
      pull(
        {
          rootDir: root,
          config,
          rest: fakeRest({ post: [item2] }),
          taxonomy,
          state: stateAfterFirst,
          events,
        },
        { type: 'post' },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Body unchanged on disk — pull halted before any writes.
    const text = await fs.readFile(path, 'utf8');
    const { meta } = decode(text);
    expect(meta.modified_gmt).toBe('2025-01-01T00:00:00');
  });

  it('resolutions: "keep-server" lets pull overwrite local for that slug', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'a');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    const item2 = makeItem({
      id: 1,
      slug: 'a',
      modified_gmt: '2025-04-01T00:00:00',
      content: { raw: '<p>server wins for a</p>', rendered: '' },
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [item2] }),
        taxonomy,
        state: stateAfter,
        events,
      },
      { type: 'post', resolutions: { 'post/a': 'keep-server' } },
    );
    expect(result.written).toBe(1);
    const text = await fs.readFile(path, 'utf8');
    expect(text).toContain('<p>server wins for a</p>');
  });

  it('resolutions: "keep-local" leaves the file untouched', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'a');
    const future = Date.now() / 1000 + 60;
    await fs.writeFile(path, await fs.readFile(path, 'utf8') + '\n<!-- local edit -->', 'utf8');
    await fs.utimes(path, future, future);

    const item2 = makeItem({
      id: 1,
      slug: 'a',
      modified_gmt: '2025-04-01T00:00:00',
      content: { raw: '<p>server should NOT win</p>', rendered: '' },
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [item2] }),
        taxonomy,
        state: stateAfter,
        events,
      },
      { type: 'post', resolutions: { 'post/a': 'keep-local' } },
    );
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    const text = await fs.readFile(path, 'utf8');
    expect(text).toContain('<!-- local edit -->');
    expect(text).not.toContain('server should NOT win');
  });

  it('halts only on conflicts that are not in the resolutions map', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const a1 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' });
    const b1 = makeItem({ id: 2, slug: 'b', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [a1, b1] }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'post' },
    );
    const future = Date.now() / 1000 + 60;
    await fs.utimes(postFilePath(root, 'post', 'a'), future, future);
    await fs.utimes(postFilePath(root, 'post', 'b'), future, future);

    const a2 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-04-01T00:00:00' });
    const b2 = makeItem({ id: 2, slug: 'b', modified_gmt: '2025-04-01T00:00:00' });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const { ConflictError } = await import('./errors.js');
    await expect(
      pull(
        {
          rootDir: root,
          config,
          rest: fakeRest({ post: [a2, b2] }),
          taxonomy,
          state: stateAfter,
          events,
        },
        { type: 'post', resolutions: { 'post/a': 'keep-server' } }, // b unresolved
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('--force-pull overwrites local on conflict', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'contested', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'contested');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    const item2 = makeItem({
      id: 1,
      slug: 'contested',
      modified_gmt: '2025-04-01T00:00:00',
      content: { raw: '<p>server wins</p>', rendered: '' },
    });
    const stateAfterFirst: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [item2] }),
        taxonomy,
        state: stateAfterFirst,
        events,
      },
      { type: 'post', forcePull: true },
    );
    expect(result.written).toBe(1);
    const text = await fs.readFile(path, 'utf8');
    const { meta, body } = decode(text);
    expect(meta.modified_gmt).toBe('2025-04-01T00:00:00');
    expect(body).toBe('<p>server wins</p>');
  });

  it('emits start with the total count and done with written/skipped', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const observed: { startTotal?: number; doneWritten?: number } = {};
    events.on('start', (e) => (observed.startTotal = e.total));
    events.on('done', (e) => (observed.doneWritten = e.written));

    await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ post: [makeItem({ slug: 'a' }), makeItem({ slug: 'b' })] }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'post' },
    );
    expect(observed.startTotal).toBe(2);
    expect(observed.doneWritten).toBe(2);
  });
});
