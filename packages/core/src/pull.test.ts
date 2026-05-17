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

interface FakeRestItems {
  post?: RestItem[];
  page?: RestItem[];
  trashedPost?: RestItem[];
  trashedPage?: RestItem[];
}

function fakeRest(itemsByType: FakeRestItems): RestClient {
  const trashFor = (type: 'post' | 'page'): RestItem[] =>
    (type === 'post' ? itemsByType.trashedPost : itemsByType.trashedPage) ?? [];
  return {
    listItems: (type, listOpts) =>
      (async function* () {
        const list = listOpts.status === 'trash' ? trashFor(type) : (itemsByType[type] ?? []);
        for (const item of list) yield item;
      })(),
    countItems: async (type) => (itemsByType[type] ?? []).length,
    listTaxonomy: () => (async function* () {})(),
    getMe: async () => ({ id: 0, slug: '' }),
    getItem: async (type, id) => {
      const all = [...(itemsByType[type] ?? []), ...trashFor(type)];
      const item = all.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`No fake ${type} item with id ${id}`);
      return item;
    },
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

  it('skips unsupported WordPress statuses instead of aborting the whole pull', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const itemEvents: SyncEvents['item'][] = [];
    const logEvents: SyncEvents['log'][] = [];
    events.on('item', (e) => itemEvents.push(e));
    events.on('log', (e) => logEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({
          post: [
            makeItem({ slug: 'supported' }),
            makeItem({ slug: 'workflow-draft', status: 'archived' }),
          ],
        }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect(itemEvents.map((e) => `${e.slug}:${e.action}`)).toEqual([
      'post/supported:create',
      'post/workflow-draft:skip',
    ]);
    expect(logEvents.find((e) => e.level === 'warn')).toMatchObject({
      level: 'warn',
      msg: expect.stringContaining('Unsupported WordPress post status "archived"'),
    });
    await expect(fs.access(postFilePath(root, 'post', 'supported'))).resolves.toBeUndefined();
    await expect(fs.access(postFilePath(root, 'post', 'workflow-draft'))).rejects.toThrow();
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

  it('deletes the local file when a server post is trashed and local is unchanged', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'gone', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'gone');
    await expect(fs.access(path)).resolves.toBeUndefined();

    const trashed = makeItem({
      id: 1,
      slug: 'gone',
      status: 'trash',
      modified_gmt: '2025-02-01T00:00:00',
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: stateAfter,
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(1);
    expect(itemEvents.at(-1)).toMatchObject({ action: 'delete', slug: 'post/gone' });
    await expect(fs.access(path)).rejects.toThrow();
    expect(result.newState.last_sync).toBe('2025-02-01T00:00:00');
  });

  it('detects server-side deletion for pages too (not just posts)', async () => {
    const events = new TypedEmitter<SyncEvents>();
    // Seed a page via a live pull.
    const livePage = makeItem({
      id: 12,
      type: 'page',
      slug: 'about',
      parent: 0,
      modified_gmt: '2025-01-01T00:00:00',
    });
    await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ page: [livePage] }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'page' },
    );
    const path = postFilePath(root, 'page', 'about');
    await expect(fs.access(path)).resolves.toBeUndefined();

    // Now the page is trashed on the server — WP suffixes the slug.
    const trashedPage = makeItem({
      id: 12,
      type: 'page',
      slug: 'about__trashed',
      parent: 0,
      status: 'trash',
      modified_gmt: '2025-02-01T00:00:00',
    });
    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPage: [trashedPage] }),
        taxonomy,
        state: { schema_version: 1, last_sync: '2025-01-01T00:00:00' },
        events,
      },
      { type: 'page' },
    );

    expect(result.written).toBe(1);
    expect(itemEvents.at(-1)).toMatchObject({ action: 'delete', slug: 'page/about' });
    await expect(fs.access(path)).rejects.toThrow();
  });

  it('strips WP\'s __trashed slug suffix when matching the local file', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 5, slug: 'about', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'about');
    await expect(fs.access(path)).resolves.toBeUndefined();

    // WP renames the slug to `<original>__trashed` when a post is trashed.
    const trashed = makeItem({
      id: 5,
      slug: 'about__trashed',
      status: 'trash',
      modified_gmt: '2025-02-01T00:00:00',
    });

    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: { schema_version: 1, last_sync: '2025-01-01T00:00:00' },
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(1);
    expect(itemEvents.at(-1)).toMatchObject({ action: 'delete', slug: 'post/about' });
    await expect(fs.access(path)).rejects.toThrow();
  });

  it('halts with ConflictError when local was edited and server trashed it', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'edited-then-trashed', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'edited-then-trashed');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    const trashed = makeItem({
      id: 1,
      slug: 'edited-then-trashed',
      status: 'trash',
      modified_gmt: '2025-02-01T00:00:00',
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const { ConflictError } = await import('./errors.js');
    await expect(
      pull(
        {
          rootDir: root,
          config,
          rest: fakeRest({ trashedPost: [trashed] }),
          taxonomy,
          state: stateAfter,
          events,
        },
        { type: 'post' },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Conflict halt = zero writes. File must still be on disk.
    await expect(fs.access(path)).resolves.toBeUndefined();
  });

  it('deletion conflict resolved as "keep-server" removes the local file', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'a');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    const trashed = makeItem({
      id: 1,
      slug: 'a',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: stateAfter,
        events,
      },
      { type: 'post', resolutions: { 'post/a': 'keep-server' } },
    );

    expect(result.written).toBe(1);
    await expect(fs.access(path)).rejects.toThrow();
  });

  it('deletion conflict resolved as "keep-local" keeps the file and logs a warning', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'a', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'a');
    const future = Date.now() / 1000 + 60;
    await fs.utimes(path, future, future);

    const trashed = makeItem({
      id: 1,
      slug: 'a',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });
    const stateAfter: State = { schema_version: 1, last_sync: '2025-01-01T00:00:00' };

    const logEvents: SyncEvents['log'][] = [];
    events.on('log', (e) => logEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: stateAfter,
        events,
      },
      { type: 'post', resolutions: { 'post/a': 'keep-local' } },
    );

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    await expect(fs.access(path)).resolves.toBeUndefined();
    expect(logEvents.find((e) => e.level === 'warn' && /post\/a/.test(e.msg))).toBeTruthy();
  });

  it('ignores a trashed item when no local file exists', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const trashed = makeItem({
      id: 42,
      slug: 'never-pulled',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });
    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: emptyState,
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(0);
    expect(itemEvents).toEqual([]);
  });

  it('ignores a trashed item when local has a different id (different post under the same slug)', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 99, slug: 'reused-slug', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'reused-slug');

    const trashed = makeItem({
      id: 7,
      slug: 'reused-slug',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: { schema_version: 1, last_sync: '2025-01-01T00:00:00' },
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(0);
    await expect(fs.access(path)).resolves.toBeUndefined();
  });

  it('skips trash deletion when local file already has status: trash (push owns it)', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'local-tombstone', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'local-tombstone');
    const text = await fs.readFile(path, 'utf8');
    await fs.writeFile(path, text.replace(/status:\s*publish/, 'status: trash'), 'utf8');

    const trashed = makeItem({
      id: 1,
      slug: 'local-tombstone',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });

    const result = await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: { schema_version: 1, last_sync: '2025-01-01T00:00:00' },
        events,
      },
      { type: 'post' },
    );

    expect(result.written).toBe(0);
    await expect(fs.access(path)).resolves.toBeUndefined();
  });

  it('dryRun emits delete action for a trashed item but keeps the local file', async () => {
    const events = new TypedEmitter<SyncEvents>();
    const item1 = makeItem({ id: 1, slug: 'going', modified_gmt: '2025-01-01T00:00:00' });
    await pull(
      { rootDir: root, config, rest: fakeRest({ post: [item1] }), taxonomy, state: emptyState, events },
      { type: 'post' },
    );
    const path = postFilePath(root, 'post', 'going');

    const trashed = makeItem({
      id: 1,
      slug: 'going',
      status: 'trash',
      modified_gmt: '2025-04-01T00:00:00',
    });
    const itemEvents: SyncEvents['item'][] = [];
    events.on('item', (e) => itemEvents.push(e));

    await pull(
      {
        rootDir: root,
        config,
        rest: fakeRest({ trashedPost: [trashed] }),
        taxonomy,
        state: { schema_version: 1, last_sync: '2025-01-01T00:00:00' },
        events,
      },
      { type: 'post', dryRun: true },
    );

    expect(itemEvents.at(-1)).toMatchObject({ action: 'delete', slug: 'post/going' });
    await expect(fs.access(path)).resolves.toBeUndefined();
  });
});
