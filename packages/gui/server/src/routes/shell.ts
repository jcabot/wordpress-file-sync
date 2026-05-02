import { Router } from 'express';
import { configPath } from '@wpsync/core';
import { default as openModule } from 'open';
import { currentRootDir } from '../session.js';

export function shellRouter(): Router {
  const r = Router();

  r.post('/config/open', async (_req, res) => {
    const root = currentRootDir();
    if (!root) {
      res.json({ ok: false, code: 'usage', message: 'Not configured.' });
      return;
    }
    try {
      await openModule(configPath(root));
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, code: 'other', message: err instanceof Error ? err.message : String(err) });
    }
  });

  return r;
}
