import {
  AuthError,
  createCredentialStore,
  createSyncSession,
  loadConfig,
  type Config,
  type SyncEvents,
  type SyncSession,
} from '@wpsync/core';
import type { SseHub } from './sse.js';

interface State {
  rootDir: string | null;
  config: Config | null;
  session: SyncSession | null;
}

const state: State = { rootDir: null, config: null, session: null };

let hub: SseHub | null = null;

export function setHub(h: SseHub): void {
  hub = h;
}

function attachForwarder(session: SyncSession): void {
  const types: (keyof SyncEvents)[] = ['start', 'item', 'conflict', 'done', 'log'];
  for (const t of types) {
    session.events.on(t, (payload) => {
      if (hub) hub.broadcastRaw(t, payload);
    });
  }
}

export async function adoptSession(rootDir: string): Promise<SyncSession> {
  const config = await loadConfig(rootDir);
  const store = createCredentialStore(rootDir);
  const password = await store.get(config.site_url);
  if (!password) {
    throw new AuthError('No stored credentials. Run setup again.');
  }
  const session = createSyncSession({
    rootDir,
    config,
    credentials: { username: config.username, password },
  });
  attachForwarder(session);
  state.rootDir = rootDir;
  state.config = config;
  state.session = session;
  return session;
}

export function currentSession(): SyncSession | null {
  return state.session;
}

export function currentRootDir(): string | null {
  return state.rootDir;
}

export function currentConfig(): Config | null {
  return state.config;
}
