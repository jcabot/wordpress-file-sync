import { join } from 'node:path';
import type { PostType } from './types.js';

export function configDir(rootDir: string): string {
  return join(rootDir, '.wpsync');
}

export function configPath(rootDir: string): string {
  return join(configDir(rootDir), 'config.toml');
}

export function statePath(rootDir: string): string {
  return join(configDir(rootDir), 'state.json');
}

export function taxonomyPath(rootDir: string): string {
  return join(configDir(rootDir), 'taxonomy.json');
}

export function gitignorePath(rootDir: string): string {
  return join(rootDir, '.gitignore');
}

export function typeDir(rootDir: string, type: PostType): string {
  return join(rootDir, type === 'post' ? 'posts' : 'pages');
}

export function postFilePath(rootDir: string, type: PostType, slug: string): string {
  return join(typeDir(rootDir, type), `${slug}.html`);
}

// PRD §8 AC: slugs can collide across `posts/` and `pages/`, so all user-facing
// item references (conflict reports, log lines, item events) must be `<type>/<slug>`.
export function slugKey(type: PostType, slug: string): string {
  return `${type}/${slug}`;
}
