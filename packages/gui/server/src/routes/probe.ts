import { Router } from 'express';
import { createSyncSession } from '@wpsync/core';
import { mapError } from '../error-mapping.js';
import { currentRootDir } from '../session.js';

interface ProbeBody {
  siteUrl?: string;
}

interface AuthBody {
  siteUrl?: string;
  username?: string;
  password?: string;
}

export function probeRouter(): Router {
  const r = Router();

  r.post('/probe-url', async (req, res) => {
    const { siteUrl } = (req.body ?? {}) as ProbeBody;
    if (!siteUrl) {
      res.status(400).json({ ok: false, message: 'siteUrl is required' });
      return;
    }
    try {
      const probeRes = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/`);
      if (!probeRes.ok) {
        res.json({ ok: false, message: `HTTP ${probeRes.status}` });
        return;
      }
      const body = (await probeRes.json()) as { name?: string; namespaces?: string[] };
      const looksLikeWp = Array.isArray(body.namespaces) && body.namespaces.includes('wp/v2');
      res.json(
        looksLikeWp
          ? { ok: true, name: body.name ?? '' }
          : { ok: false, message: 'Reachable but not a WordPress REST API root' },
      );
    } catch (err) {
      res.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  r.post('/auth/test', async (req, res) => {
    const { siteUrl, username, password } = (req.body ?? {}) as AuthBody;
    if (!siteUrl || !username || !password) {
      res.status(400).json({ ok: false, code: 'usage', message: 'siteUrl, username, password are all required' });
      return;
    }
    try {
      const session = createSyncSession({
        rootDir: currentRootDir() ?? '.',
        config: {
          site_url: siteUrl,
          content_dir: '.',
          enabled_types: ['post', 'page'],
          username,
        },
        credentials: { username, password },
      });
      const me = await session.testAuth();
      res.json({ ok: true, slug: me.slug, id: me.id });
    } catch (err) {
      const mapped = mapError(err);
      res.json({ ok: false, code: mapped.code, message: mapped.message });
    }
  });

  return r;
}
