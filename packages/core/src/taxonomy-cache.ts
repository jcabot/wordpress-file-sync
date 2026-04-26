import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { RestClient } from './rest-client.js';
import { taxonomyPath } from './paths.js';

type TaxType = 'categories' | 'tags';

interface TaxFile {
  version: 1;
  categories: Record<string, string>;
  tags: Record<string, string>;
}

const EMPTY: TaxFile = { version: 1, categories: {}, tags: {} };

export interface TaxonomyCache {
  slugById(type: TaxType, id: number): Promise<string | null>;
  idBySlug(type: TaxType, slug: string): Promise<number | null>;
  refresh(type?: TaxType): Promise<void>;
}

export function createTaxonomyCache(rootDir: string, rest: RestClient): TaxonomyCache {
  let mem: TaxFile | null = null;

  async function read(): Promise<TaxFile> {
    if (mem) return mem;
    try {
      const text = await fs.readFile(taxonomyPath(rootDir), 'utf8');
      const parsed = JSON.parse(text) as TaxFile;
      if (parsed.version === 1 && parsed.categories && parsed.tags) {
        mem = parsed;
        return mem;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    mem = { ...EMPTY, categories: {}, tags: {} };
    return mem;
  }

  async function write(file: TaxFile): Promise<void> {
    const path = taxonomyPath(rootDir);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, path);
    mem = file;
  }

  async function refreshOne(type: TaxType): Promise<void> {
    const file = await read();
    const map: Record<string, string> = {};
    for await (const term of rest.listTaxonomy(type)) {
      map[String(term.id)] = term.slug;
    }
    file[type] = map;
    await write(file);
  }

  function findIdInMap(map: Record<string, string>, slug: string): number | null {
    for (const [id, s] of Object.entries(map)) {
      if (s === slug) return Number.parseInt(id, 10);
    }
    return null;
  }

  return {
    async slugById(type, id) {
      const file = await read();
      const hit = file[type][String(id)];
      if (hit !== undefined) return hit;
      await refreshOne(type);
      const fresh = (await read())[type][String(id)];
      return fresh ?? null;
    },

    async idBySlug(type, slug) {
      const file = await read();
      const hit = findIdInMap(file[type], slug);
      if (hit !== null) return hit;
      await refreshOne(type);
      const refreshed = (await read())[type];
      return findIdInMap(refreshed, slug);
    },

    async refresh(type) {
      if (type) {
        await refreshOne(type);
      } else {
        await refreshOne('categories');
        await refreshOne('tags');
      }
    },
  };
}
