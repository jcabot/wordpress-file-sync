import { describe, it, expect } from 'vitest';
import { isConflicted, localChanged, serverChanged } from './conflict.js';

const REF = '2025-04-22T15:30:00';
const refMs = Date.parse(REF + 'Z');

describe('isConflicted', () => {
  it('returns false when both sides are at the reference timestamp', () => {
    expect(
      isConflicted({
        serverModifiedGmt: REF,
        localModifiedGmt: REF,
        fileMtimeMs: refMs,
      }),
    ).toBe(false);
  });

  it('returns false when only the server has changed', () => {
    expect(
      isConflicted({
        serverModifiedGmt: '2025-04-22T16:00:00',
        localModifiedGmt: REF,
        fileMtimeMs: refMs,
      }),
    ).toBe(false);
  });

  it('returns false when only the local file has changed', () => {
    expect(
      isConflicted({
        serverModifiedGmt: REF,
        localModifiedGmt: REF,
        fileMtimeMs: refMs + 60_000,
      }),
    ).toBe(false);
  });

  it('returns true when both sides have changed', () => {
    expect(
      isConflicted({
        serverModifiedGmt: '2025-04-22T16:00:00',
        localModifiedGmt: REF,
        fileMtimeMs: refMs + 60_000,
      }),
    ).toBe(true);
  });

  it('respects the 2-second mtime tolerance', () => {
    // 1500 ms ahead — within tolerance, treated as not changed.
    expect(
      isConflicted({
        serverModifiedGmt: '2025-04-22T16:00:00',
        localModifiedGmt: REF,
        fileMtimeMs: refMs + 1500,
      }),
    ).toBe(false);
    // 2500 ms ahead — beyond tolerance.
    expect(
      isConflicted({
        serverModifiedGmt: '2025-04-22T16:00:00',
        localModifiedGmt: REF,
        fileMtimeMs: refMs + 2500,
      }),
    ).toBe(true);
  });

  it('handles already-Z-suffixed timestamps too', () => {
    expect(
      isConflicted({
        serverModifiedGmt: '2025-04-22T16:00:00Z',
        localModifiedGmt: REF + 'Z',
        fileMtimeMs: refMs + 60_000,
      }),
    ).toBe(true);
  });
});

describe('serverChanged / localChanged primitives', () => {
  it('serverChanged compares strict greater-than', () => {
    expect(serverChanged(REF, REF)).toBe(false);
    expect(serverChanged('2025-04-22T16:00:00', REF)).toBe(true);
  });

  it('localChanged uses the 2s tolerance', () => {
    expect(localChanged(refMs + 1000, REF)).toBe(false);
    expect(localChanged(refMs + 3000, REF)).toBe(true);
  });
});
