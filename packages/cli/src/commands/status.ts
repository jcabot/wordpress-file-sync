import {
  AuthError,
  createCredentialStore,
  createSyncSession,
  loadConfig,
  UsageError,
  type PostType,
  type StatusEntry,
} from '@wpsync/core';
import { resolveRootDir, type GlobalOpts } from '../context.js';

export interface StatusCmdOpts extends GlobalOpts {
  type?: string;
}

function parseType(value: string | undefined): PostType | undefined {
  if (value === undefined) return undefined;
  if (value !== 'post' && value !== 'page') {
    throw new UsageError(`--type must be "post" or "page", got "${value}"`);
  }
  return value;
}

function printList(label: string, entries: StatusEntry[]): void {
  if (entries.length === 0) return;
  console.log(`\n${label} (${entries.length}):`);
  for (const e of entries) {
    console.log(`  ${e.type}/${e.slug}`);
  }
}

export async function statusCommand(opts: StatusCmdOpts): Promise<void> {
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

  const type = parseType(opts.type);
  const result = await session.status(type ? { type } : {});

  console.log(`Site:      ${config.site_url}`);
  console.log(`Last sync: ${result.lastSync ?? '(never)'}`);

  printList('Pending pulls (server changed)', result.byCategory.pendingPull);
  printList('Pending pushes (local changed)', result.byCategory.pendingPush);
  printList('New local files (will be created)', result.byCategory.newLocal);
  printList('Tombstones (queued for deletion)', result.byCategory.tombstone);
  printList('Conflicts (both sides changed)', result.byCategory.conflict);

  const totalToAct =
    result.byCategory.pendingPull.length +
    result.byCategory.pendingPush.length +
    result.byCategory.newLocal.length +
    result.byCategory.tombstone.length +
    result.byCategory.conflict.length;
  if (totalToAct === 0) {
    console.log('\nNothing to do.');
  }
}
