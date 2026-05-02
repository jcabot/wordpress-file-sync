export interface BridgeEvent {
  type: 'start' | 'item' | 'conflict' | 'done' | 'log';
  payload: unknown;
}

export interface ItemEvent {
  op: 'pull' | 'push';
  slug: string;
  index: number;
  total: number;
  action: 'create' | 'update' | 'delete' | 'skip';
}

export interface DoneEvent {
  op: 'pull' | 'push';
  written: number;
  skipped: number;
}

export interface ConflictEvent {
  slugs: string[];
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface ConfigCheck {
  configured: boolean;
  rootDir?: string;
  siteUrl?: string;
  username?: string;
}

export type BridgeError =
  | { ok: false; code: 'auth'; message: string }
  | { ok: false; code: 'conflict'; message: string; slugs?: string[] }
  | { ok: false; code: 'transport'; message: string }
  | { ok: false; code: 'usage'; message: string }
  | { ok: false; code: 'other'; message: string };

export interface StatusCounts {
  pendingPull: number;
  pendingPush: number;
  conflict: number;
  tombstone: number;
  newLocal: number;
  upToDate: number;
}

export interface StatusEntry {
  type: 'post' | 'page';
  slug: string;
  state:
    | 'up-to-date'
    | 'pending-pull'
    | 'pending-push'
    | 'conflict'
    | 'tombstone'
    | 'new-local';
}

export type ConflictResolution = 'keep-local' | 'keep-server' | 'skip';
export type ConflictResolutions = Record<string, ConflictResolution>;

export interface FsEntry {
  name: string;
  isDir: boolean;
}

export interface FsListResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok && res.status >= 500) {
    throw new Error(`POST ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async lastRootDir(): Promise<string | null> {
    const r = await getJson<{ rootDir: string | null }>('/api/state/last-root');
    return r.rootDir;
  },

  async checkConfig(rootDir: string | null): Promise<ConfigCheck> {
    if (!rootDir) return { configured: false };
    return getJson<ConfigCheck>(`/api/config?root=${encodeURIComponent(rootDir)}`);
  },

  async fsList(path: string | null): Promise<FsListResult> {
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    return getJson<FsListResult>(`/api/fs/list${q}`);
  },

  async fsHome(): Promise<string> {
    const r = await getJson<{ path: string }>('/api/fs/home');
    return r.path;
  },

  async testWpJson(siteUrl: string): Promise<{ ok: boolean; name?: string; message?: string }> {
    return postJson('/api/probe-url', { siteUrl });
  },

  async testAuth(args: {
    siteUrl: string;
    username: string;
    password: string;
  }): Promise<{ ok: true; slug: string; id: number } | BridgeError> {
    return postJson('/api/auth/test', args);
  },

  async init(args: {
    rootDir: string;
    siteUrl: string;
    username: string;
    password: string;
  }): Promise<{ ok: true } | BridgeError> {
    return postJson('/api/init', args);
  },

  async adopt(rootDir: string): Promise<{ ok: true } | BridgeError> {
    return postJson('/api/adopt', { rootDir });
  },

  async status(): Promise<
    | {
        ok: true;
        lastSync: string | null;
        counts: StatusCounts;
        entries: StatusEntry[];
      }
    | BridgeError
  > {
    return getJson('/api/status');
  },

  async pull(args?: {
    full?: boolean;
    forcePull?: boolean;
    resolutions?: ConflictResolutions;
  }): Promise<{ ok: true; written: number } | BridgeError> {
    return postJson('/api/pull', args ?? {});
  },

  async push(args?: {
    forcePush?: boolean;
    resolutions?: ConflictResolutions;
  }): Promise<{ ok: true; written: number; skipped: number } | BridgeError> {
    return postJson('/api/push', args ?? {});
  },

  async openConfigFile(): Promise<{ ok: true } | BridgeError> {
    return postJson('/api/config/open');
  },

  onEvent(cb: (event: BridgeEvent) => void): () => void {
    const es = new EventSource('/api/events');
    const types: BridgeEvent['type'][] = ['start', 'item', 'conflict', 'done', 'log'];
    const handlers = types.map((t) => {
      const handler = (msg: MessageEvent<string>): void => {
        try {
          const payload = JSON.parse(msg.data);
          cb({ type: t, payload });
        } catch {
          // ignore malformed event
        }
      };
      es.addEventListener(t, handler as EventListener);
      return [t, handler] as const;
    });
    return () => {
      for (const [t, h] of handlers) es.removeEventListener(t, h as EventListener);
      es.close();
    };
  },
};
