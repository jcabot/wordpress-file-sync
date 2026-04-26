import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import { resolveRootDir } from './context.js';

describe('resolveRootDir', () => {
  it('uses cwd when no --config is given', () => {
    expect(resolveRootDir({})).toBe(process.cwd());
  });

  it('strips two segments off a --config path', () => {
    const root = resolveRootDir({ config: `C:${sep}foo${sep}bar${sep}.wpsync${sep}config.toml` });
    expect(root.endsWith(`${sep}foo${sep}bar`)).toBe(true);
  });
});
