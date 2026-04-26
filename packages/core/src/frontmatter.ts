import YAML from 'yaml';
import type { FrontMatter } from './types.js';

const FENCE = '---';

const KEY_ORDER: (keyof FrontMatter)[] = [
  'id',
  'type',
  'slug',
  'title',
  'status',
  'parent',
  'categories',
  'tags',
  'featured_media',
  'excerpt',
  'date_gmt',
  'modified_gmt',
];

export function encode(meta: FrontMatter, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const val = meta[key];
    if (val !== undefined) ordered[key] = val;
  }
  const yamlText = YAML.stringify(ordered, { lineWidth: 0 });
  return `${FENCE}\n${yamlText}${FENCE}\n\n${body}`;
}

export function decode(text: string): { meta: FrontMatter; body: string } {
  if (!text.startsWith(`${FENCE}\n`)) {
    throw new Error('frontmatter: missing opening fence');
  }
  const closeIdx = text.indexOf(`\n${FENCE}\n`, FENCE.length + 1);
  if (closeIdx === -1) {
    throw new Error('frontmatter: missing closing fence');
  }
  const yamlText = text.slice(FENCE.length + 1, closeIdx + 1);
  const rest = text.slice(closeIdx + FENCE.length + 2);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;

  const parsed = YAML.parse(yamlText, { schema: 'core' }) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('frontmatter: YAML did not parse to an object');
  }
  return { meta: parsed as FrontMatter, body };
}
