import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import {
  configDir,
  configPath,
  statePath,
  taxonomyPath,
  typeDir,
  postFilePath,
} from './paths.js';

describe('paths', () => {
  const root = `C:${sep}root`;

  it('places config and state inside .wpsync/', () => {
    expect(configDir(root).endsWith(`${sep}.wpsync`)).toBe(true);
    expect(configPath(root).endsWith(`${sep}config.toml`)).toBe(true);
    expect(statePath(root).endsWith(`${sep}state.json`)).toBe(true);
    expect(taxonomyPath(root).endsWith(`${sep}taxonomy.json`)).toBe(true);
  });

  it('maps post type to its directory', () => {
    expect(typeDir(root, 'post').endsWith(`${sep}posts`)).toBe(true);
    expect(typeDir(root, 'page').endsWith(`${sep}pages`)).toBe(true);
  });

  it('builds post file paths under the type directory', () => {
    const p = postFilePath(root, 'post', 'hello-world');
    expect(p.endsWith(`${sep}posts${sep}hello-world.html`)).toBe(true);
  });
});
