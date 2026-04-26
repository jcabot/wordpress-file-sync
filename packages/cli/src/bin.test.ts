import { describe, it, expect } from 'vitest';
import { VERSION } from '@wpsync/core';

describe('@wpsync/cli', () => {
  it('imports the core package', () => {
    expect(typeof VERSION).toBe('string');
  });
});
