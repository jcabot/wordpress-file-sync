import 'dotenv/config';
import { default as openModule } from 'open';
import { createApp } from './app.js';

const PORT = Number(process.env['WPSYNC_PORT'] ?? 4319);
const DEV = process.env['WPSYNC_DEV'] === '1';
const OPEN_BROWSER = process.env['WPSYNC_OPEN_BROWSER'] !== 'false';

const app = createApp({ dev: DEV });

const server = app.listen(PORT, '127.0.0.1', () => {
  const url = DEV ? `http://localhost:5173` : `http://localhost:${PORT}`;
  console.log(`wpsync GUI server listening on http://127.0.0.1:${PORT}${DEV ? ' (dev mode — Vite at 5173)' : ''}`);
  console.log(`Open ${url} to use the app.`);
  if (OPEN_BROWSER && !DEV) {
    void openModule(url).catch(() => {
      // best-effort; not fatal
    });
  }
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
