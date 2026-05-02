import { promises as fs } from 'node:fs';
import { Router } from 'express';
import {
  createCredentialStore,
  createSyncSession,
  EMPTY_STATE,
  ensureConfigDir,
  gitignorePath,
  saveConfig,
  saveState,
  type Config,
} from '@wpsync/core';
import { mapError } from '../error-mapping.js';
import { adoptSession } from '../session.js';
import { saveAppState } from '../state.js';

const GITIGNORE_LINE = '.wpsync/credentials.json';

interface InitBody {
  rootDir?: string;
  siteUrl?: string;
  username?: string;
  password?: string;
}

interface AdoptBody {
  rootDir?: string;
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

export function initRouter(): Router {
  const r = Router();

  r.post('/init', async (req, res) => {
    const { rootDir, siteUrl, username, password } = (req.body ?? {}) as InitBody;
    if (!rootDir || !siteUrl || !username || !password) {
      res.status(400).json({ ok: false, code: 'usage', message: 'rootDir, siteUrl, username, password are required' });
      return;
    }
    try {
      const config: Config = {
        site_url: siteUrl.trim().replace(/\/+$/, ''),
        content_dir: '.',
        enabled_types: ['post', 'page'],
        username,
      };
      const probe = createSyncSession({
        rootDir,
        config,
        credentials: { username, password },
      });
      await probe.testAuth();

      await ensureConfigDir(rootDir);
      await saveConfig(rootDir, config);
      await saveState(rootDir, EMPTY_STATE);
      const store = createCredentialStore(rootDir);
      await store.set(config.site_url, password);
      await ensureGitignore(rootDir);
      await saveAppState({ rootDir });
      await adoptSession(rootDir);
      res.json({ ok: true });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message });
    }
  });

  r.post('/adopt', async (req, res) => {
    const { rootDir } = (req.body ?? {}) as AdoptBody;
    if (!rootDir) {
      res.status(400).json({ ok: false, code: 'usage', message: 'rootDir is required' });
      return;
    }
    try {
      await adoptSession(rootDir);
      await saveAppState({ rootDir });
      res.json({ ok: true });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message });
    }
  });

  return r;
}
