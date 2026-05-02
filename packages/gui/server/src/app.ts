import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import cors from 'cors';
import { SseHub } from './sse.js';
import { setHub } from './session.js';
import { configRouter } from './routes/config.js';
import { fsRouter } from './routes/fs.js';
import { probeRouter } from './routes/probe.js';
import { initRouter } from './routes/init.js';
import { statusRouter } from './routes/status.js';
import { syncRouter } from './routes/sync.js';
import { shellRouter } from './routes/shell.js';

export interface AppOptions {
  dev?: boolean;
  clientDistDir?: string;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  const hub = new SseHub();
  setHub(hub);

  if (opts.dev) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: false }));
  }
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/events', (_req, res) => {
    hub.attach(res);
  });

  app.use('/api', configRouter());
  app.use('/api', fsRouter());
  app.use('/api', probeRouter());
  app.use('/api', initRouter());
  app.use('/api', statusRouter());
  app.use('/api', syncRouter());
  app.use('/api', shellRouter());

  if (!opts.dev) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = opts.clientDistDir ?? join(here, '..', 'dist-client');
    if (existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^(?!\/api\/).*/, (_req, res) => {
        res.sendFile(join(dist, 'index.html'));
      });
    }
  }

  return app;
}
