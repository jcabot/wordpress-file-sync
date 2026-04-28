#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import {
  AuthError,
  ConflictError,
  TransportError,
  UsageError,
  VERSION,
} from '@wpsync/core';
import { initCommand } from './commands/init.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { statusCommand } from './commands/status.js';
import { authCommand } from './commands/auth.js';

const program = new Command();

program
  .name('wpsync')
  .description('Bidirectional WordPress ↔ local filesystem sync')
  .version(VERSION)
  .option('-v, --verbose', 'verbose output')
  .option('-q, --quiet', 'quiet output (errors only)')
  .option('-c, --config <path>', 'path to .wpsync/config.toml');

program
  .command('init [siteUrl]')
  .description('scaffold .wpsync/ and run the auth flow')
  .option('-d, --dir <path>', 'directory to scaffold into (created if missing); defaults to cwd')
  .action(async (siteUrl: string | undefined, cmdOpts: { dir?: string }) => {
    await initCommand({
      ...program.opts(),
      ...(siteUrl ? { siteUrl } : {}),
      ...(cmdOpts.dir ? { dir: cmdOpts.dir } : {}),
    });
  });

program
  .command('pull')
  .description('pull changes from WordPress to local')
  .option('--full', 'ignore last_sync and re-pull everything')
  .option('--type <type>', 'restrict to one type (post|page)')
  .option('--dry-run', 'list changes without writing files')
  .option('--force-pull', 'on conflict, overwrite local with the server version')
  .action(
    async (opts: {
      full?: boolean;
      type?: string;
      dryRun?: boolean;
      forcePull?: boolean;
    }) => {
      await pullCommand({ ...program.opts(), ...opts });
    },
  );

program
  .command('push')
  .description('push local changes to WordPress')
  .option('--type <type>', 'restrict to one type (post|page)')
  .option('--dry-run', 'list changes without sending')
  .option('--force-push', 'on conflict, overwrite the server with the local version')
  .action(
    async (opts: { type?: string; dryRun?: boolean; forcePush?: boolean }) => {
      await pushCommand({ ...program.opts(), ...opts });
    },
  );

program
  .command('status')
  .description('show pending pulls, pushes, conflicts, and tombstones')
  .option('--type <type>', 'restrict to one type (post|page)')
  .action(async (opts: { type?: string }) => {
    await statusCommand({ ...program.opts(), ...opts });
  });

const auth = program.command('auth').description('manage credentials');
auth
  .command('set')
  .description('store an Application Password (prompts for input)')
  .action(async () => {
    await authCommand({ ...program.opts(), sub: 'set' });
  });
auth
  .command('test')
  .description('verify credentials by calling /users/me')
  .action(async () => {
    await authCommand({ ...program.opts(), sub: 'test' });
  });
auth
  .command('clear')
  .description('remove stored credentials')
  .action(async () => {
    await authCommand({ ...program.opts(), sub: 'clear' });
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    if (err.exitCode !== 0) process.stderr.write(`${err.message}\n`);
    process.exitCode = err.exitCode === 0 ? 0 : 2;
  } else if (err instanceof AuthError) {
    process.stderr.write(`auth: ${err.message}\n`);
    process.exitCode = 3;
  } else if (err instanceof ConflictError) {
    process.stderr.write(`conflict: ${err.message}\n`);
    process.exitCode = 4;
  } else if (err instanceof TransportError) {
    process.stderr.write(`transport: ${err.message}\n`);
    process.exitCode = 5;
  } else if (err instanceof UsageError) {
    process.stderr.write(`usage: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(err instanceof Error ? `${err.message}\n` : `${String(err)}\n`);
    process.exitCode = 1;
  }
}
