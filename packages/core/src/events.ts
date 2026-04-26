export type SyncEvents = {
  start: { op: 'pull' | 'push'; total?: number };
  item: {
    op: 'pull' | 'push';
    slug: string;
    index: number;
    total: number;
    action: 'create' | 'update' | 'delete' | 'skip';
  };
  conflict: { slugs: string[] };
  done: { op: 'pull' | 'push'; written: number; skipped: number };
  log: { level: 'info' | 'warn' | 'error'; msg: string };
};

type Listener<E> = (payload: E) => void;

export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Listener<Events[K]>[] } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const arr = this.listeners[event];
    if (!arr) return this;
    const i = arr.indexOf(listener);
    if (i !== -1) arr.splice(i, 1);
    return this;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const l of arr) l(payload);
  }
}
