import { describe, it, expect } from 'vitest';
import { AuthError, ConflictError, TransportError, UsageError } from '@wpsync/core';
import { mapError } from './error-mapping.js';

describe('mapError', () => {
  it('maps AuthError to 401 + code:auth', () => {
    const m = mapError(new AuthError('bad creds'));
    expect(m).toEqual({ code: 'auth', message: 'bad creds', status: 401 });
  });

  it('maps ConflictError to 409 + code:conflict + slugs', () => {
    const m = mapError(new ConflictError(['post/foo', 'post/bar']));
    expect(m.status).toBe(409);
    expect(m.code).toBe('conflict');
    expect(m.slugs).toEqual(['post/foo', 'post/bar']);
  });

  it('maps TransportError to 502 + code:transport', () => {
    const m = mapError(new TransportError('boom'));
    expect(m.status).toBe(502);
    expect(m.code).toBe('transport');
  });

  it('maps UsageError to 400 + code:usage', () => {
    const m = mapError(new UsageError('bad arg'));
    expect(m.status).toBe(400);
    expect(m.code).toBe('usage');
  });

  it('falls back to 500 + code:other for unknown errors', () => {
    const m = mapError(new Error('mystery'));
    expect(m.status).toBe(500);
    expect(m.code).toBe('other');
    expect(m.message).toBe('mystery');
  });

  it('handles thrown non-Error values', () => {
    const m = mapError('boom');
    expect(m.status).toBe(500);
    expect(m.code).toBe('other');
    expect(m.message).toBe('boom');
  });
});
