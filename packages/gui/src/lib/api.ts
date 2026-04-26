// Typed wrapper around the contextBridge API exposed by electron/preload.ts.

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

interface WpsyncBridge {
  lastRootDir(): Promise<string | null>;
  checkConfig(rootDir: string | null): Promise<ConfigCheck>;
  pickFolder(): Promise<string | null>;
  testWpJson(siteUrl: string): Promise<{ ok: boolean; name?: string; message?: string }>;
  testAuth(args: {
    siteUrl: string;
    username: string;
    password: string;
  }): Promise<{ ok: true; slug: string; id: number } | BridgeError>;
  init(args: {
    rootDir: string;
    siteUrl: string;
    username: string;
    password: string;
  }): Promise<{ ok: true } | BridgeError>;
  adopt(rootDir: string): Promise<{ ok: true } | BridgeError>;
  status(): Promise<
    | {
        ok: true;
        lastSync: string | null;
        counts: StatusCounts;
        entries: StatusEntry[];
      }
    | BridgeError
  >;
  pull(args?: {
    full?: boolean;
    forcePull?: boolean;
    resolutions?: ConflictResolutions;
  }): Promise<{ ok: true; written: number } | BridgeError>;
  push(args?: {
    forcePush?: boolean;
    resolutions?: ConflictResolutions;
  }): Promise<{ ok: true; written: number; skipped: number } | BridgeError>;
  openConfigFile(): Promise<{ ok: true } | BridgeError>;
  onEvent(cb: (event: BridgeEvent) => void): () => void;
}

declare global {
  interface Window {
    wpsync: WpsyncBridge;
  }
}

export const api: WpsyncBridge = window.wpsync;
