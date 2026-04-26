import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter, type SyncEvents } from './events.js';

describe('TypedEmitter', () => {
  it('delivers payloads to subscribed listeners', () => {
    const e = new TypedEmitter<SyncEvents>();
    const fn = vi.fn();
    e.on('item', fn);
    e.emit('item', { op: 'pull', slug: 'a', index: 0, total: 1, action: 'create' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]?.[0]).toMatchObject({ slug: 'a', action: 'create' });
  });

  it('off() removes a listener', () => {
    const e = new TypedEmitter<SyncEvents>();
    const fn = vi.fn();
    e.on('log', fn);
    e.off('log', fn);
    e.emit('log', { level: 'info', msg: 'hi' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('emit on a never-subscribed event is a no-op', () => {
    const e = new TypedEmitter<SyncEvents>();
    expect(() => e.emit('done', { op: 'pull', written: 0, skipped: 0 })).not.toThrow();
  });
});
