import { promises as fs } from 'node:fs';
import {
  createCredentialStore,
  createSyncSession,
  ensureConfigDir,
  EMPTY_STATE,
  gitignorePath,
  saveConfig,
  saveState,
  UsageError,
  type Config,
} from '@wpsync/core';
import { prompt, promptHidden } from '../prompt.js';
import { resolveRootDir, type GlobalOpts } from '../context.js';

const GITIGNORE_LINE = '.wpsync/secrets.json';

export interface InitOpts extends GlobalOpts {
  siteUrl?: string;
}

function normaliseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new UsageError('site URL must start with http:// or https://');
  }
  return trimmed;
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

export async function initCommand(opts: InitOpts): Promise<void> {
  const rootDir = resolveRootDir(opts);

  const siteUrlRaw =
    opts.siteUrl ?? process.env['WPSYNC_SITE_URL'] ?? (await prompt('Site URL: '));
  const siteUrl = normaliseUrl(siteUrlRaw);

  const username =
    process.env['WPSYNC_USERNAME'] ?? (await prompt('WordPress username: '));
  if (!username) throw new UsageError('username is required');

  const password =
    process.env['WPSYNC_PASSWORD'] ?? (await promptHidden('Application Password: '));
  if (!password) throw new UsageError('password is required');

  const config: Config = {
    site_url: siteUrl,
    content_dir: '.',
    enabled_types: ['post', 'page'],
    username,
  };

  if (!opts.quiet) console.log(`Verifying credentials at ${siteUrl}…`);
  const session = createSyncSession({
    rootDir,
    config,
    credentials: { username, password },
  });
  const me = await session.testAuth();
  if (!opts.quiet) console.log(`Authenticated as "${me.slug}" (user id ${me.id}).`);

  await ensureConfigDir(rootDir);
  await saveConfig(rootDir, config);
  await saveState(rootDir, EMPTY_STATE);

  const store = createCredentialStore(rootDir);
  await store.set(siteUrl, password);
  const backend = await store.backendName();

  await ensureGitignore(rootDir);

  if (!opts.quiet) {
    console.log(`Wrote .wpsync/config.toml and .wpsync/state.json under ${rootDir}.`);
    console.log(`Credentials stored in ${backend === 'keychain' ? 'OS keychain' : 'encrypted .wpsync/secrets.json'}.`);
    console.log('Next: `wpsync pull` to mirror your site locally.');
  }
}
