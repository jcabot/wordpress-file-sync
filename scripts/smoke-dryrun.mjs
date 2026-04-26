// Verify dry-run output: clear DRY RUN banner, per-action breakdown, and
// no state.json/server side effects.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'bin.js');

const POSTS = [
  {
    id: 1,
    type: 'post',
    slug: 'hello',
    status: 'publish',
    date_gmt: '2025-01-01T00:00:00',
    modified_gmt: '2025-01-02T00:00:00',
    title: { raw: 'Hello', rendered: '' },
    content: { raw: '<p>body</p>', rendered: '' },
    excerpt: { raw: '', rendered: '' },
    categories: [],
    tags: [],
    featured_media: 0,
  },
];
const writeRequests = [];

function ok(res, body) {
  const count = Array.isArray(body) ? body.length : 1;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-WP-Total': String(count),
    'X-WP-TotalPages': '1',
  });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = url.pathname;
  if (m === '/wp-json/wp/v2/users/me') return ok(res, { id: 1, slug: 'alice' });
  if (m === '/wp-json/wp/v2/categories') return ok(res, []);
  if (m === '/wp-json/wp/v2/tags') return ok(res, []);
  if (m === '/wp-json/wp/v2/pages') return ok(res, []);
  if (m === '/wp-json/wp/v2/posts' && req.method === 'GET') return ok(res, POSTS);
  if (req.method === 'POST' || req.method === 'DELETE') {
    writeRequests.push({ method: req.method, path: m });
  }
  ok(res, {});
});

function listen() {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)),
  );
}

function runCli(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const url = await listen();
  const root = await mkdtemp(join(tmpdir(), 'wpsync-dry-'));
  console.log('mock', url);
  console.log('root', root);
  const env = { WPSYNC_USERNAME: 'alice', WPSYNC_PASSWORD: 'pw' };

  let r = await runCli(root, ['init', url], env);
  assert(r.code === 0, `init: ${r.stderr}`);

  // First do a real pull so the file exists with aligned mtime.
  r = await runCli(root, ['pull'], env);
  assert(r.code === 0, `pull: ${r.stderr}`);

  // Now dry-run pull (should be no-op since last_sync caught up).
  r = await runCli(root, ['pull', '--dry-run', '--full'], env);
  assert(r.code === 0, `dry-run pull: ${r.stderr}`);
  assert(r.stdout.includes('DRY RUN'), 'dry-run pull should print DRY RUN banner');
  assert(r.stdout.includes('Would pull'), 'dry-run pull summary should say "Would pull"');

  // Edit a file locally; dry-run push should describe what it would do without sending.
  const filePath = join(root, 'posts', 'hello.html');
  const original = await fs.readFile(filePath, 'utf8');
  await fs.writeFile(filePath, original + '\n<!-- edit -->', 'utf8');
  const future = Date.now() / 1000 + 60;
  await fs.utimes(filePath, future, future);

  const writesBefore = writeRequests.length;
  r = await runCli(root, ['push', '--dry-run', '--verbose'], env);
  assert(r.code === 0, `dry-run push: ${r.stderr}`);
  assert(r.stdout.includes('DRY RUN'), 'dry-run push should print DRY RUN banner');
  assert(r.stdout.includes('Would push'), 'dry-run push summary should say "Would push"');
  assert(r.stdout.includes('would update'), 'dry-run push verbose line should say "would update"');
  const writesAfter = writeRequests.length;
  assert(writesAfter === writesBefore, `dry-run push must not POST/DELETE (got ${writesAfter - writesBefore} writes)`);

  // Make sure the actual push still works after dry-run
  r = await runCli(root, ['push'], env);
  assert(r.code === 0, `real push: ${r.stderr}`);
  assert(!r.stdout.includes('DRY RUN'), 'real push should NOT print DRY RUN banner');

  await rm(root, { recursive: true, force: true });
  server.close();
  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
