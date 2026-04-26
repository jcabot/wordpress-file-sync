import { UsageError } from './errors.js';
import type { FrontMatter, PostStatus, PostType, RestItem } from './types.js';
import type { TaxonomyCache } from './taxonomy-cache.js';

const VALID_STATUSES: PostStatus[] = [
  'publish',
  'draft',
  'pending',
  'private',
  'future',
  'trash',
];

function asPostType(value: string): PostType {
  if (value === 'post' || value === 'page') return value;
  throw new Error(`mapper: unsupported post type "${value}"`);
}

function asPostStatus(value: string): PostStatus {
  const found = VALID_STATUSES.find((s) => s === value);
  if (!found) throw new Error(`mapper: unsupported status "${value}"`);
  return found;
}

async function resolveSlugs(
  ids: number[] | undefined,
  taxonomy: TaxonomyCache,
  type: 'categories' | 'tags',
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  const out: string[] = [];
  for (const id of ids) {
    const slug = await taxonomy.slugById(type, id);
    if (slug !== null) out.push(slug);
  }
  return out;
}

export async function restItemToFrontmatter(
  item: RestItem,
  taxonomy: TaxonomyCache,
): Promise<{ meta: FrontMatter; body: string }> {
  const type = asPostType(item.type);
  const meta: FrontMatter = {
    id: item.id,
    type,
    slug: item.slug,
    title: item.title.raw,
    status: asPostStatus(item.status),
    featured_media: item.featured_media,
    excerpt: item.excerpt.raw,
    date_gmt: item.date_gmt,
    modified_gmt: item.modified_gmt,
  };

  if (type === 'page') {
    meta.parent = item.parent ?? 0;
  } else {
    meta.categories = await resolveSlugs(item.categories, taxonomy, 'categories');
    meta.tags = await resolveSlugs(item.tags, taxonomy, 'tags');
  }

  return { meta, body: item.content.raw };
}

async function resolveIds(
  slugs: string[],
  taxonomy: TaxonomyCache,
  type: 'categories' | 'tags',
): Promise<number[]> {
  const ids: number[] = [];
  for (const slug of slugs) {
    const id = await taxonomy.idBySlug(type, slug);
    if (id === null) {
      const term = type === 'categories' ? 'category' : 'tag';
      throw new UsageError(
        `Unknown ${term} slug "${slug}". Create it in WordPress admin first, then re-run.`,
      );
    }
    ids.push(id);
  }
  return ids;
}

export async function frontmatterToPayload(
  meta: FrontMatter,
  body: string,
  taxonomy: TaxonomyCache,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    title: meta.title,
    status: meta.status,
    content: body,
    excerpt: meta.excerpt,
    date_gmt: meta.date_gmt,
    slug: meta.slug,
    featured_media: meta.featured_media,
  };

  if (meta.type === 'post') {
    payload['categories'] = await resolveIds(meta.categories ?? [], taxonomy, 'categories');
    payload['tags'] = await resolveIds(meta.tags ?? [], taxonomy, 'tags');
  } else {
    payload['parent'] = meta.parent ?? 0;
  }

  return payload;
}
