import { TypedEmitter, type SyncEvents } from './events.js';
import { createRestClient, type FetchImpl } from './rest-client.js';
import { createTaxonomyCache } from './taxonomy-cache.js';
import { loadState, saveState } from './state.js';
import { pull, type PullOptions, type PullResult } from './pull.js';
import { push, type PushOptions, type PushResult } from './push.js';
import { status, type StatusOptions, type StatusResult } from './status.js';
import type { Config, Credentials } from './types.js';

export interface SyncSessionOptions {
  rootDir: string;
  config: Config;
  credentials: Credentials;
  fetchImpl?: FetchImpl;
}

export interface SyncSession {
  events: TypedEmitter<SyncEvents>;
  testAuth(): Promise<{ id: number; slug: string }>;
  pull(opts?: PullOptions): Promise<PullResult>;
  push(opts?: PushOptions): Promise<PushResult>;
  status(opts?: StatusOptions): Promise<StatusResult>;
}

export function createSyncSession(opts: SyncSessionOptions): SyncSession {
  const events = new TypedEmitter<SyncEvents>();
  const rest = createRestClient({
    siteUrl: opts.config.site_url,
    username: opts.credentials.username,
    password: opts.credentials.password,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const taxonomy = createTaxonomyCache(opts.rootDir, rest);

  return {
    events,
    testAuth: () => rest.getMe(),
    async pull(pullOpts = {}) {
      const state = await loadState(opts.rootDir);
      const result = await pull(
        {
          rootDir: opts.rootDir,
          config: opts.config,
          rest,
          taxonomy,
          state,
          events,
        },
        pullOpts,
      );
      if (!pullOpts.dryRun) {
        await saveState(opts.rootDir, result.newState);
      }
      return result;
    },
    async push(pushOpts = {}) {
      return push(
        {
          rootDir: opts.rootDir,
          config: opts.config,
          rest,
          taxonomy,
          events,
        },
        pushOpts,
      );
    },
    async status(statusOpts = {}) {
      const state = await loadState(opts.rootDir);
      return status(
        {
          rootDir: opts.rootDir,
          config: opts.config,
          rest,
          state,
        },
        statusOpts,
      );
    },
  };
}
