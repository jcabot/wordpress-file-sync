import { describe, it, expect } from 'vitest';
import { encode, decode } from './frontmatter.js';
import type { FrontMatter } from './types.js';

const meta: FrontMatter = {
  id: 1234,
  type: 'post',
  slug: 'my-first-post',
  title: 'My First Post',
  status: 'publish',
  categories: ['research', 'mde'],
  tags: ['besser', 'low-code'],
  featured_media: 5678,
  excerpt: 'Short summary.',
  date_gmt: '2025-01-10T10:00:00',
  modified_gmt: '2025-04-22T15:30:00',
};

const body = `<!-- wp:paragraph -->
<p>Raw post_content goes here.</p>
<!-- /wp:paragraph -->`;

describe('frontmatter', () => {
  it('encode → decode is loss-free for meta and body', () => {
    const text = encode(meta, body);
    const round = decode(text);
    expect(round.meta).toEqual(meta);
    expect(round.body).toBe(body);
  });

  it('encode → decode → encode is byte-stable', () => {
    const a = encode(meta, body);
    const { meta: m, body: b } = decode(a);
    const c = encode(m, b);
    expect(c).toBe(a);
  });

  it('preserves Gutenberg block markers verbatim', () => {
    const gutenberg = '<!-- wp:heading -->\n<h2>Hi</h2>\n<!-- /wp:heading -->';
    const text = encode(meta, gutenberg);
    expect(decode(text).body).toBe(gutenberg);
  });

  it('preserves a body that starts with a blank line', () => {
    const blank = '\n\nleading blanks';
    const text = encode(meta, blank);
    expect(decode(text).body).toBe(blank);
  });

  it('keeps date_gmt as a string (no auto Date coercion)', () => {
    const text = encode(meta, body);
    const m = decode(text).meta;
    expect(typeof m.date_gmt).toBe('string');
    expect(m.date_gmt).toBe('2025-01-10T10:00:00');
  });

  it('emits keys in canonical order', () => {
    const text = encode(meta, '');
    const yaml = text.split('---\n')[1] ?? '';
    const lines = yaml.split('\n').filter((l) => /^\w/.test(l));
    const keys = lines.map((l) => (l.split(':')[0] ?? '').trim());
    expect(keys).toEqual([
      'id',
      'type',
      'slug',
      'title',
      'status',
      'categories',
      'tags',
      'featured_media',
      'excerpt',
      'date_gmt',
      'modified_gmt',
    ]);
  });

  it('throws on text with no front-matter', () => {
    expect(() => decode('hello world')).toThrow(/opening fence/);
  });

  it('throws on text with no closing fence', () => {
    expect(() => decode('---\nfoo: 1\nno close')).toThrow(/closing fence/);
  });
});
