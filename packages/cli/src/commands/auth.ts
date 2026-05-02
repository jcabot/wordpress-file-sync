import {
  AuthError,
  createCredentialStore,
  createSyncSession,
  loadConfig,
  saveConfig,
  UsageError,
} from '@wpsync/core';
import { prompt, promptHidden } from '../prompt.js';
import { resolveRootDir, type GlobalOpts } from '../context.js';

export interface AuthOpts extends GlobalOpts {
  sub: 'set' | 'test' | 'clear';
}

export async function authCommand(opts: AuthOpts): Promise<void> {
  const rootDir = resolveRootDir(opts);
  const config = await loadConfig(rootDir);
  const store = createCredentialStore(rootDir);

  if (opts.sub === 'set') {
    const username =
      process.env['WPSYNC_USERNAME'] ?? (await prompt(`WordPress username [${config.username}]: `));
    const finalUsername = username || config.username;
    const password =
      process.env['WPSYNC_PASSWORD'] ?? (await promptHidden('Application Password: '));
    if (!password) throw new UsageError('password is required');

    if (!opts.quiet) console.log(`Verifying at ${config.site_url}…`);
    const session = createSyncSession({
      rootDir,
      config: { ...config, username: finalUsername },
      credentials: { username: finalUsername, password },
    });
    const me = await session.testAuth();

    await store.set(config.site_url, password);
    if (finalUsername !== config.username) {
      await saveConfig(rootDir, { ...config, username: finalUsername });
    }
    if (!opts.quiet) {
      console.log('Stored in .wpsync/credentials.json (mode 600).');
      console.log(`Authenticated as "${me.slug}" (user id ${me.id}).`);
    }
    return;
  }

  if (opts.sub === 'test') {
    const password = await store.get(config.site_url);
    if (!password) throw new AuthError('No stored credentials. Run `wpsync auth set` first.');
    const session = createSyncSession({
      rootDir,
      config,
      credentials: { username: config.username, password },
    });
    const me = await session.testAuth();
    console.log(`OK: authenticated as "${me.slug}" (user id ${me.id}) at ${config.site_url}.`);
    return;
  }

  // clear
  await store.clear(config.site_url);
  if (!opts.quiet) console.log(`Credentials for ${config.site_url} cleared.`);
}
