import { describe, it, expect } from 'vitest';
import { frontmatterToPayload, restItemToFrontmatter } from './mapper.js';
import { UsageError } from './errors.js';
import type { FrontMatter, RestItem } from './types.js';
import type { TaxonomyCache } from './taxonomy-cache.js';

const taxonomy: TaxonomyCache = {
  async slugById(type, id) {
    if (type === 'categories' && id === 7) return 'research';
    if (type === 'categories' && id === 8) return 'mde';
    if (type === 'tags' && id === 9) return 'besser';
    return null;
  },
  async idBySlug(type, slug) {
    if (type === 'categories' && slug === 'research') return 7;
    if (type === 'categories' && slug === 'mde') return 8;
    if (type === 'tags' && slug === 'besser') return 9;
    return null;
  },
  async refresh() {
    /* no-op */
  },
};

const baseItem: RestItem = {
  id: 1234,
  type: 'post',
  slug: 'my-first-post',
  status: 'publish',
  date_gmt: '2025-01-10T10:00:00',
  modified_gmt: '2025-04-22T15:30:00',
  title: { raw: 'My First Post', rendered: '' },
  content: { raw: '<p>verbatim</p>', rendered: '' },
  excerpt: { raw: 'Short summary.', rendered: '' },
  categories: [7, 8],
  tags: [9],
  featured_media: 5678,
};

describe('mapper', () => {
  it('maps a post REST item into front-matter + verbatim body', async () => {
    const { meta, body } = await restItemToFrontmatter(baseItem, taxonomy);
    expect(meta.id).toBe(1234);
    expect(meta.type).toBe('post');
    expect(meta.slug).toBe('my-first-post');
    expect(meta.title).toBe('My First Post');
    expect(meta.status).toBe('publish');
    expect(meta.categories).toEqual(['research', 'mde']);
    expect(meta.tags).toEqual(['besser']);
    expect(meta.featured_media).toBe(5678);
    expect(meta.date_gmt).toBe('2025-01-10T10:00:00');
    expect(meta.modified_gmt).toBe('2025-04-22T15:30:00');
    expect(meta.parent).toBeUndefined();
    expect(body).toBe('<p>verbatim</p>');
  });

  it('emits parent (and not categories/tags) for pages', async () => {
    const page: RestItem = { ...baseItem, type: 'page', parent: 42 };
    const { meta } = await restItemToFrontmatter(page, taxonomy);
    expect(meta.type).toBe('page');
    expect(meta.parent).toBe(42);
    expect(meta.categories).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });

  it('drops unknown taxonomy IDs rather than failing', async () => {
    const item: RestItem = { ...baseItem, categories: [7, 999], tags: [9, 998] };
    const { meta } = await restItemToFrontmatter(item, taxonomy);
    expect(meta.categories).toEqual(['research']);
    expect(meta.tags).toEqual(['besser']);
  });

  it('rejects unsupported post types', async () => {
    const item = { ...baseItem, type: 'attachment' };
    await expect(restItemToFrontmatter(item as RestItem, taxonomy)).rejects.toThrow(
      /unsupported post type/,
    );
  });

  it('rejects unsupported statuses', async () => {
    const item = { ...baseItem, status: 'archived' };
    await expect(restItemToFrontmatter(item as RestItem, taxonomy)).rejects.toThrow(
      /unsupported status/,
    );
  });
});

describe('frontmatterToPayload', () => {
  const postMeta: FrontMatter = {
    id: 42,
    type: 'post',
    slug: 'hello',
    title: 'Hello',
    status: 'publish',
    categories: ['research', 'mde'],
    tags: ['besser'],
    featured_media: 7,
    excerpt: 'short',
    date_gmt: '2025-01-10T10:00:00',
    modified_gmt: '2025-04-22T15:30:00',
  };

  it('maps a post front-matter to a REST payload with resolved category/tag IDs', async () => {
    const payload = await frontmatterToPayload(postMeta, '<p>body</p>', taxonomy);
    expect(payload).toEqual({
      title: 'Hello',
      status: 'publish',
      content: '<p>body</p>',
      excerpt: 'short',
      date_gmt: '2025-01-10T10:00:00',
      slug: 'hello',
      featured_media: 7,
      categories: [7, 8],
      tags: [9],
    });
  });

  it('omits taxonomies and includes parent for pages', async () => {
    const pageMeta: FrontMatter = {
      ...postMeta,
      type: 'page',
      categories: undefined,
      tags: undefined,
      parent: 3,
    };
    const payload = await frontmatterToPayload(pageMeta, '<p>body</p>', taxonomy);
    expect(payload['parent']).toBe(3);
    expect(payload['categories']).toBeUndefined();
    expect(payload['tags']).toBeUndefined();
  });

  it('throws UsageError on unknown category slug', async () => {
    const meta: FrontMatter = { ...postMeta, categories: ['research', 'never-heard-of-it'] };
    await expect(frontmatterToPayload(meta, '', taxonomy)).rejects.toBeInstanceOf(UsageError);
  });

  it('treats missing categories/tags arrays as empty', async () => {
    const meta: FrontMatter = { ...postMeta, categories: undefined, tags: undefined };
    const payload = await frontmatterToPayload(meta, '', taxonomy);
    expect(payload['categories']).toEqual([]);
    expect(payload['tags']).toEqual([]);
  });
});
