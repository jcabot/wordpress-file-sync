import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaxonomyCache } from './taxonomy-cache.js';
import type { RestClient } from './rest-client.js';
import type { TaxonomyTerm } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wpsync-tax-'));
  return async () => {
    await rm(root, { recursive: true, force: true });
  };
});

function fakeRest(categories: TaxonomyTerm[], tags: TaxonomyTerm[]): RestClient {
  return {
    listItems: () => {
      throw new Error('not used');
    },
    countItems: async () => 0,
    listTaxonomy: (type) =>
      (async function* () {
        for (const t of type === 'categories' ? categories : tags) yield t;
      })(),
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

describe('taxonomy-cache', () => {
  it('lazy-loads from REST on a miss and resolves the slug', async () => {
    const rest = fakeRest(
      [{ id: 7, slug: 'research', name: 'Research' }],
      [{ id: 9, slug: 'mde', name: 'MDE' }],
    );
    const cache = createTaxonomyCache(root, rest);
    expect(await cache.slugById('categories', 7)).toBe('research');
    expect(await cache.slugById('tags', 9)).toBe('mde');
  });

  it('persists a cache file under .wpsync/', async () => {
    const rest = fakeRest([{ id: 1, slug: 'a', name: 'A' }], []);
    const cache = createTaxonomyCache(root, rest);
    await cache.slugById('categories', 1);
    const { promises: fs } = await import('node:fs');
    const text = await fs.readFile(join(root, '.wpsync', 'taxonomy.json'), 'utf8');
    const parsed = JSON.parse(text) as { categories: Record<string, string> };
    expect(parsed.categories['1']).toBe('a');
  });

  it('does not refetch when the ID is already cached', async () => {
    const listSpy = vi.fn(async function* (type: 'categories' | 'tags') {
      yield { id: 1, slug: type === 'categories' ? 'cat' : 'tag', name: 'X' };
    });
    const rest: RestClient = {
      listItems: () => {
        throw new Error('not used');
      },
      countItems: async () => 0,
      listTaxonomy: listSpy as unknown as RestClient['listTaxonomy'],
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
    const cache = createTaxonomyCache(root, rest);
    await cache.slugById('categories', 1);
    await cache.slugById('categories', 1);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when an ID is missing even after a refresh', async () => {
    const rest = fakeRest([], []);
    const cache = createTaxonomyCache(root, rest);
    expect(await cache.slugById('categories', 999)).toBeNull();
  });

  it('idBySlug looks up by slug and refreshes on miss', async () => {
    let calls = 0;
    const rest: RestClient = {
      listItems: () => {
        throw new Error('not used');
      },
      countItems: async () => 0,
      listTaxonomy: (type) =>
        (async function* () {
          calls += 1;
          if (type === 'categories') {
            yield { id: 7, slug: 'research', name: 'Research' };
            if (calls > 1) yield { id: 8, slug: 'fresh', name: 'Fresh' };
          }
        })(),
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
    const cache = createTaxonomyCache(root, rest);
    expect(await cache.idBySlug('categories', 'research')).toBe(7);
    expect(await cache.idBySlug('categories', 'fresh')).toBe(8);
  });

  it('idBySlug returns null when slug is unknown after refresh', async () => {
    const rest = fakeRest([{ id: 1, slug: 'a', name: 'A' }], []);
    const cache = createTaxonomyCache(root, rest);
    expect(await cache.idBySlug('categories', 'never-existed')).toBeNull();
  });
});
