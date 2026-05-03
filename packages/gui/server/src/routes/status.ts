import { Router } from 'express';
import { loadState, UsageError } from '@wpsync/core';
import { mapError } from '../error-mapping.js';
import { currentRootDir } from '../session.js';

export function statusRouter(): Router {
  const r = Router();

  r.get('/status', async (_req, res) => {
    try {
      const root = currentRootDir();
      if (!root) throw new UsageError('Not configured.');
      const state = await loadState(root);
      res.json({ ok: true, lastSync: state.last_sync ?? null });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message });
    }
  });

  return r;
}
