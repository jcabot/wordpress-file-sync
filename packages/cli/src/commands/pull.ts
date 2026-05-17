import {
  AuthError,
  createCredentialStore,
  createSyncSession,
  loadConfig,
  UsageError,
  type PostType,
} from '@wpsync/core';
import { resolveRootDir, type GlobalOpts } from '../context.js';

export interface PullCmdOpts extends GlobalOpts {
  full?: boolean;
  type?: string;
  dryRun?: boolean;
  forcePull?: boolean;
}

function parseType(value: string | undefined): PostType | undefined {
  if (value === undefined) return undefined;
  if (value !== 'post' && value !== 'page') {
    throw new UsageError(`--type must be "post" or "page", got "${value}"`);
  }
  return value;
}

export async function pullCommand(opts: PullCmdOpts): Promise<void> {
  const rootDir = resolveRootDir(opts);
  const config = await loadConfig(rootDir);
  const store = createCredentialStore(rootDir);
  const password = await store.get(config.site_url);
  if (!password) {
    throw new AuthError('No stored credentials. Run `wpsync auth set` first.');
  }

  const session = createSyncSession({
    rootDir,
    config,
    credentials: { username: config.username, password },
  });

  const counts = { create: 0, update: 0, delete: 0, skip: 0 };
  const linePrefix = opts.dryRun ? '[DRY] ' : '';
  const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];
  const red = (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

  session.events.on('item', (e) => {
    counts[e.action] = (counts[e.action] ?? 0) + 1;
    if (opts.verbose) {
      const total = e.total > 0 ? `/${e.total}` : '';
      const raw = opts.dryRun ? `would ${e.action}` : e.action;
      const verb = e.action === 'delete' ? red(raw) : raw;
      process.stdout.write(`${linePrefix}[${e.index}${total}] ${e.slug}: ${verb}\n`);
    }
  });
  session.events.on('log', (e) => {
    if (e.level === 'error' || opts.verbose) {
      process.stderr.write(`[${e.level}] ${e.msg}\n`);
    }
  });

  if (opts.dryRun && !opts.quiet) {
    console.log('DRY RUN — no files will be written and last_sync will not advance.');
  }

  const type = parseType(opts.type);
  const result = await session.pull({
    full: opts.full ?? false,
    ...(type ? { type } : {}),
    dryRun: opts.dryRun ?? false,
    forcePull: opts.forcePull ?? false,
  });

  if (!opts.quiet) {
    const verb = opts.dryRun ? 'Would pull' : 'Pulled';
    const deletedStr = counts.delete > 0
      ? `, ${red(`deleted ${counts.delete}`)}`
      : `, deleted ${counts.delete}`;
    console.log(
      `${verb} ${result.written} item${result.written === 1 ? '' : 's'}` +
        ` (created ${counts.create}, updated ${counts.update}${deletedStr}, skipped ${counts.skip}).`,
    );
    if (!opts.dryRun && result.newState.last_sync) {
      console.log(`last_sync = ${result.newState.last_sync}`);
    }
  }
}
