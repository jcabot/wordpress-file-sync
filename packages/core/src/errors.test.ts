import { describe, it, expect } from 'vitest';
import {
  AuthError,
  ConflictError,
  TransportError,
  UnsupportedRestItemError,
  UsageError,
  WpsyncError,
} from './errors.js';

describe('errors', () => {
  it('AuthError defaults to a clear message', () => {
    const e = new AuthError();
    expect(e).toBeInstanceOf(WpsyncError);
    expect(e.message).toBe('Authentication failed');
    expect(e.name).toBe('AuthError');
  });

  it('TransportError carries status and cause', () => {
    const cause = new Error('underlying');
    const e = new TransportError('boom', { status: 500, cause });
    expect(e.status).toBe(500);
    expect(e.cause).toBe(cause);
  });

  it('ConflictError lists slugs', () => {
    const e = new ConflictError(['posts/foo', 'pages/bar']);
    expect(e.slugs).toEqual(['posts/foo', 'pages/bar']);
    expect(e.message).toContain('posts/foo');
  });

  it('UsageError is its own class', () => {
    const e = new UsageError('bad flag');
    expect(e.name).toBe('UsageError');
  });

  it('UnsupportedRestItemError is its own class', () => {
    const e = new UnsupportedRestItemError('bad REST item');
    expect(e.name).toBe('UnsupportedRestItemError');
  });
});
