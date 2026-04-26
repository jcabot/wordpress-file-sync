import { promises as fs } from 'node:fs';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  AuthError,
  ConflictError,
  TransportError,
  UsageError,
  createCredentialStore,
  createSyncSession,
  EMPTY_STATE,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  saveState,
  configPath,
  gitignorePath,
  type Config,
  type ConflictResolutions,
  type SyncSession,
  type SyncEvents,
} from '@wpsync/core';
import { saveAppState } from './state-store.js';

const GITIGNORE_LINE = '.wpsync/secrets.json';

export interface InitArgs {
  rootDir: string;
  siteUrl: string;
  username: string;
  password: string;
}

export interface PullArgs {
  full?: boolean;
  forcePull?: boolean;
  resolutions?: ConflictResolutions;
}

export interface PushArgs {
  forcePush?: boolean;
  resolutions?: ConflictResolutions;
}

interface BridgeState {
  rootDir: string | null;
  config: Config | null;
  session: SyncSession | null;
}

const bridgeState: BridgeState = { rootDir: null, config: null, session: null };

function broadcast<K extends keyof SyncEvents>(
  window: BrowserWindow,
  type: K,
  payload: SyncEvents[K],
): void {
  if (!window.isDestroyed()) {
    window.webContents.send('wpsync:event', { type, payload });
  }
}

function attachEventForwarder(window: BrowserWindow, session: SyncSession): void {
  const events = ['start', 'item', 'conflict', 'done', 'log'] as const;
  for (const name of events) {
    session.events.on(name, (payload) => broadcast(window, name, payload));
  }
}

async function adoptSession(window: BrowserWindow, rootDir: string): Promise<SyncSession> {
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
  attachEventForwarder(window, session);
  bridgeState.rootDir = rootDir;
  bridgeState.config = config;
  bridgeState.session = session;
  return session;
}

async function ensureGitignore(rootDir: string): Promise<void> {
  const path = gitignorePath(rootDir);
  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing.split(/\r?\n/).includes(GITIGNORE_LINE)) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(path, `${existing}${sep}${GITIGNORE_LINE}\n`, 'utf8');
}

async function checkConfigured(rootDir: string): Promise<boolean> {
  try {
    await fs.access(configPath(rootDir));
    return true;
  } catch {
    return false;
  }
}

function classifyError(err: unknown): { code: 'auth' | 'conflict' | 'transport' | 'usage' | 'other'; message: string; slugs?: string[] } {
  if (err instanceof AuthError) return { code: 'auth', message: err.message };
  if (err instanceof ConflictError) return { code: 'conflict', message: err.message, slugs: err.slugs };
  if (err instanceof TransportError) return { code: 'transport', message: err.message };
  if (err instanceof UsageError) return { code: 'usage', message: err.message };
  return { code: 'other', message: err instanceof Error ? err.message : String(err) };
}

export function registerBridge(window: BrowserWindow): void {
  ipcMain.handle('wpsync:checkConfig', async (_e, rootDir: string | null) => {
    if (!rootDir) return { configured: false };
    if (!(await checkConfigured(rootDir))) return { configured: false };
    const config = await loadConfig(rootDir);
    return { configured: true, rootDir, siteUrl: config.site_url, username: config.username };
  });

  ipcMain.handle('wpsync:testWpJson', async (_e, siteUrl: string) => {
    try {
      const res = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/`);
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as { name?: string; namespaces?: string[] };
      const looksLikeWp = Array.isArray(body.namespaces) && body.namespaces.includes('wp/v2');
      return looksLikeWp
        ? { ok: true, name: body.name ?? '' }
        : { ok: false, message: 'Reachable but not a WordPress REST API root' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'wpsync:testAuth',
    async (_e, args: { siteUrl: string; username: string; password: string }) => {
      try {
        const session = createSyncSession({
          rootDir: bridgeState.rootDir ?? '.',
          config: {
            site_url: args.siteUrl,
            content_dir: '.',
            enabled_types: ['post', 'page'],
            username: args.username,
          },
          credentials: { username: args.username, password: args.password },
        });
        const me = await session.testAuth();
        return { ok: true, slug: me.slug, id: me.id };
      } catch (err) {
        return { ok: false, ...classifyError(err) };
      }
    },
  );

  ipcMain.handle('wpsync:init', async (_e, args: InitArgs) => {
    try {
      const config: Config = {
        site_url: args.siteUrl.trim().replace(/\/+$/, ''),
        content_dir: '.',
        enabled_types: ['post', 'page'],
        username: args.username,
      };
      const probe = createSyncSession({
        rootDir: args.rootDir,
        config,
        credentials: { username: args.username, password: args.password },
      });
      await probe.testAuth();

      await ensureConfigDir(args.rootDir);
      await saveConfig(args.rootDir, config);
      await saveState(args.rootDir, EMPTY_STATE);
      const store = createCredentialStore(args.rootDir);
      await store.set(config.site_url, args.password);
      await ensureGitignore(args.rootDir);
      await saveAppState({ rootDir: args.rootDir });
      await adoptSession(window, args.rootDir);
      return { ok: true };
    } catch (err) {
      return { ok: false, ...classifyError(err) };
    }
  });

  ipcMain.handle('wpsync:adopt', async (_e, rootDir: string) => {
    try {
      await adoptSession(window, rootDir);
      await saveAppState({ rootDir });
      return { ok: true };
    } catch (err) {
      return { ok: false, ...classifyError(err) };
    }
  });

  ipcMain.handle('wpsync:status', async () => {
    try {
      if (!bridgeState.session) throw new UsageError('Not configured.');
      const result = await bridgeState.session.status();
      return {
        ok: true,
        lastSync: result.lastSync,
        counts: {
          pendingPull: result.byCategory.pendingPull.length,
          pendingPush: result.byCategory.pendingPush.length,
          conflict: result.byCategory.conflict.length,
          tombstone: result.byCategory.tombstone.length,
          newLocal: result.byCategory.newLocal.length,
          upToDate: result.byCategory.upToDate.length,
        },
        entries: result.entries,
      };
    } catch (err) {
      return { ok: false, ...classifyError(err) };
    }
  });

  ipcMain.handle('wpsync:pull', async (_e, args: PullArgs) => {
    try {
      if (!bridgeState.session) throw new UsageError('Not configured.');
      const result = await bridgeState.session.pull({
        full: args.full ?? false,
        forcePull: args.forcePull ?? false,
        ...(args.resolutions ? { resolutions: args.resolutions } : {}),
      });
      return { ok: true, written: result.written };
    } catch (err) {
      return { ok: false, ...classifyError(err) };
    }
  });

  ipcMain.handle('wpsync:push', async (_e, args: PushArgs) => {
    try {
      if (!bridgeState.session) throw new UsageError('Not configured.');
      const result = await bridgeState.session.push({
        forcePush: args.forcePush ?? false,
        ...(args.resolutions ? { resolutions: args.resolutions } : {}),
      });
      return { ok: true, written: result.written, skipped: result.skipped };
    } catch (err) {
      return { ok: false, ...classifyError(err) };
    }
  });

  ipcMain.handle('wpsync:openConfigFile', async () => {
    if (!bridgeState.rootDir) return { ok: false, code: 'usage', message: 'Not configured.' };
    const { shell } = await import('electron');
    await shell.openPath(configPath(bridgeState.rootDir));
    return { ok: true };
  });
}
