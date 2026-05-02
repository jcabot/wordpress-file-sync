import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { status } from './status.js';
import { encode } from './frontmatter.js';
import { typeDir, postFilePath } from './paths.js';
import type { Config, FrontMatter, RestItem, State } from './types.js';
import type { RestClient } from './rest-client.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-status-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

const config: Config = {
  site_url: 'https://example.com',
  content_dir: '.',
  enabled_types: ['post', 'page'],
  username: 'alice',
};

function meta(over: Partial<FrontMatter> = {}): FrontMatter {
  return {
    id: 1,
    type: 'post',
    slug: 'hello',
    title: 'Hello',
    status: 'publish',
    categories: [],
    tags: [],
    featured_media: 0,
    excerpt: '',
    date_gmt: '2025-01-01T00:00:00',
    modified_gmt: '2025-01-02T00:00:00',
    ...over,
  };
}

async function writeFile(m: FrontMatter, body: string, mtimeMs: number): Promise<string> {
  const dir = typeDir(root, m.type);
  await fs.mkdir(dir, { recursive: true });
  const path = postFilePath(root, m.type, m.slug);
  await fs.writeFile(path, encode(m, body), 'utf8');
  await fs.utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

function fakeRest(itemsByType: { post?: RestItem[]; page?: RestItem[] } = {}): RestClient {
  return {
    listItems: (type) =>
      (async function* () {
        for (const item of itemsByType[type] ?? []) yield item;
      })(),
    countItems: async () => 0,
    listTaxonomy: () => (async function* () {})(),
    getMe: async () => ({ id: 0, slug: '' }),
    createItem: async () => {
      throw new Error('not used');
    },
    updateItem: async () => {
      throw new Error('not used');
    },
    deleteItem: async () => {
      throw new Error('not used');
    },
    getItem: async () => {
      throw new Error('not used');
    },
  };
}

const stateAt = (lastSync: string | null): State => ({ schema_version: 1, last_sync: lastSync });

const restItem = (over: Partial<RestItem> = {}): RestItem => ({
  id: 1,
  type: 'post',
  slug: 'hello',
  status: 'publish',
  date_gmt: '2025-01-01T00:00:00',
  modified_gmt: '2025-01-02T00:00:00',
  title: { raw: 'Hello', rendered: '' },
  content: { raw: '', rendered: '' },
  excerpt: { raw: '', rendered: '' },
  categories: [],
  tags: [],
  featured_media: 0,
  ...over,
});

describe('status', () => {
  it('classifies a quiet site as up-to-date', async () => {
    const m = meta();
    await writeFile(m, '<p>x</p>', Date.parse(m.modified_gmt + 'Z'));
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest(),
      state: stateAt(m.modified_gmt),
    });
    expect(result.byCategory.upToDate).toHaveLength(1);
    expect(result.byCategory.pendingPull).toHaveLength(0);
    expect(result.byCategory.pendingPush).toHaveLength(0);
  });

  it('flags a server-side change as pending-pull', async () => {
    const m = meta({ modified_gmt: '2025-01-02T00:00:00' });
    await writeFile(m, '<p>x</p>', Date.parse(m.modified_gmt + 'Z'));
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest({ post: [restItem({ modified_gmt: '2025-04-01T00:00:00' })] }),
      state: stateAt('2025-01-02T00:00:00'),
    });
    expect(result.byCategory.pendingPull).toHaveLength(1);
    expect(result.byCategory.pendingPull[0]?.slug).toBe('hello');
  });

  it('flags a local edit as pending-push', async () => {
    const m = meta();
    await writeFile(m, '<p>x</p>', Date.parse(m.modified_gmt + 'Z') + 60_000);
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest(),
      state: stateAt(m.modified_gmt),
    });
    expect(result.byCategory.pendingPush).toHaveLength(1);
  });

  it('flags both-sides changed as conflict', async () => {
    const m = meta({ modified_gmt: '2025-01-02T00:00:00' });
    await writeFile(m, '<p>x</p>', Date.parse(m.modified_gmt + 'Z') + 60_000);
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest({ post: [restItem({ modified_gmt: '2025-04-01T00:00:00' })] }),
      state: stateAt('2025-01-02T00:00:00'),
    });
    expect(result.byCategory.conflict).toHaveLength(1);
    expect(result.byCategory.pendingPull).toHaveLength(0);
    expect(result.byCategory.pendingPush).toHaveLength(0);
  });

  it('flags status: trash as a tombstone', async () => {
    const m = meta({ status: 'trash' });
    await writeFile(m, '<p>doomed</p>', Date.parse(m.modified_gmt + 'Z') + 60_000);
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest(),
      state: stateAt(m.modified_gmt),
    });
    expect(result.byCategory.tombstone).toHaveLength(1);
  });

  it('flags a no-id local file as new-local (will be created)', async () => {
    const m = meta({ id: undefined as unknown as number, slug: 'fresh' });
    delete (m as Partial<FrontMatter>).id;
    await writeFile(m as FrontMatter, '<p>new</p>', Date.now());
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest(),
      state: stateAt(null),
    });
    expect(result.byCategory.newLocal).toHaveLength(1);
  });

  it('lists server items with no local file as pending-pull (new on server)', async () => {
    const result = await status({
      rootDir: root,
      config,
      rest: fakeRest({ post: [restItem({ slug: 'brand-new', id: 999 })] }),
      state: stateAt(null),
    });
    expect(result.byCategory.pendingPull).toHaveLength(1);
    expect(result.byCategory.pendingPull[0]?.slug).toBe('brand-new');
  });
});
