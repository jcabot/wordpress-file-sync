import { Router } from 'express';
import { UsageError } from '@wpsync/core';
import { mapError } from '../error-mapping.js';
import { currentSession } from '../session.js';

export function statusRouter(): Router {
  const r = Router();

  r.get('/status', async (_req, res) => {
    try {
      const session = currentSession();
      if (!session) throw new UsageError('Not configured.');
      const result = await session.status();
      res.json({
        ok: true,
        lastSync: result.lastSync,
        counts: {
          pendingPull: result.byCategory.pendingPull.length,
          pendingPush: result.byCategory.pendingPush.length,
          conflict: result.byCategory.conflict.length,
          tombstone: result.byCategory.tombstone.length,
          newLocal: result.byCategory.newLocal.length,
          upToDate: result.byCategory.upToDate.length,
        },
        entries: result.entries,
      });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message });
    }
  });

  return r;
}
