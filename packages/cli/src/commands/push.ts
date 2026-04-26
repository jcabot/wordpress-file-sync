import {
  AuthError,
  createCredentialStore,
  createSyncSession,
  loadConfig,
  UsageError,
  type PostType,
} from '@wpsync/core';
import { resolveRootDir, type GlobalOpts } from '../context.js';

export interface PushCmdOpts extends GlobalOpts {
  type?: string;
  dryRun?: boolean;
  forcePush?: boolean;
}

function parseType(value: string | undefined): PostType | undefined {
  if (value === undefined) return undefined;
  if (value !== 'post' && value !== 'page') {
    throw new UsageError(`--type must be "post" or "page", got "${value}"`);
  }
  return value;
}

export async function pushCommand(opts: PushCmdOpts): Promise<void> {
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

  session.events.on('item', (e) => {
    counts[e.action] = (counts[e.action] ?? 0) + 1;
    if (opts.verbose) {
      const total = e.total > 0 ? `/${e.total}` : '';
      const verb = opts.dryRun ? `would ${e.action}` : e.action;
      process.stdout.write(`${linePrefix}[${e.index}${total}] ${e.slug}: ${verb}\n`);
    }
  });
  session.events.on('log', (e) => {
    if (e.level === 'error' || opts.verbose || (e.level === 'warn' && !opts.quiet)) {
      process.stderr.write(`[${e.level}] ${e.msg}\n`);
    }
  });

  if (opts.dryRun && !opts.quiet) {
    console.log('DRY RUN — nothing will be sent to the server and no files will be modified.');
  }

  const type = parseType(opts.type);
  const result = await session.push({
    ...(type ? { type } : {}),
    dryRun: opts.dryRun ?? false,
    forcePush: opts.forcePush ?? false,
  });

  if (!opts.quiet) {
    const verb = opts.dryRun ? 'Would push' : 'Pushed';
    console.log(
      `${verb} ${result.written} item${result.written === 1 ? '' : 's'}` +
        ` (created ${counts.create}, updated ${counts.update}, deleted ${counts.delete}, skipped ${counts.skip}).`,
    );
  }
}
