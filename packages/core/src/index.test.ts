import { describe, it, expect } from 'vitest';
import { VERSION } from './index.js';

describe('@wpsync/core', () => {
  it('exports a VERSION string', () => {
    expect(typeof VERSION).toBe('string');
  });
});
