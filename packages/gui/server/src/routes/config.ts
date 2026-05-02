import { promises as fs } from 'node:fs';
import { Router } from 'express';
import { configPath, loadConfig } from '@wpsync/core';
import { loadAppState } from '../state.js';

export function configRouter(): Router {
  const r = Router();

  r.get('/state/last-root', async (_req, res) => {
    const s = await loadAppState();
    res.json({ rootDir: s.rootDir });
  });

  r.get('/config', async (req, res) => {
    const root = typeof req.query['root'] === 'string' ? req.query['root'] : null;
    if (!root) {
      res.json({ configured: false });
      return;
    }
    try {
      await fs.access(configPath(root));
    } catch {
      res.json({ configured: false });
      return;
    }
    const config = await loadConfig(root);
    res.json({
      configured: true,
      rootDir: root,
      siteUrl: config.site_url,
      username: config.username,
    });
  });

  return r;
}
