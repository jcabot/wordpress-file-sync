import { Router } from 'express';
import { UsageError, type ConflictResolutions } from '@wpsync/core';
import { mapError } from '../error-mapping.js';
import { currentSession } from '../session.js';

interface PullBody {
  full?: boolean;
  forcePull?: boolean;
  resolutions?: ConflictResolutions;
}

interface PushBody {
  forcePush?: boolean;
  resolutions?: ConflictResolutions;
}

export function syncRouter(): Router {
  const r = Router();

  r.post('/pull', async (req, res) => {
    const { full, forcePull, resolutions } = (req.body ?? {}) as PullBody;
    try {
      const session = currentSession();
      if (!session) throw new UsageError('Not configured.');
      const result = await session.pull({
        full: full ?? false,
        forcePull: forcePull ?? false,
        ...(resolutions ? { resolutions } : {}),
      });
      res.json({ ok: true, written: result.written });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message, ...(mapped.slugs ? { slugs: mapped.slugs } : {}) });
    }
  });

  r.post('/push', async (req, res) => {
    const { forcePush, resolutions } = (req.body ?? {}) as PushBody;
    try {
      const session = currentSession();
      if (!session) throw new UsageError('Not configured.');
      const result = await session.push({
        forcePush: forcePush ?? false,
        ...(resolutions ? { resolutions } : {}),
      });
      res.json({ ok: true, written: result.written, skipped: result.skipped });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message, ...(mapped.slugs ? { slugs: mapped.slugs } : {}) });
    }
  });

  return r;
}
