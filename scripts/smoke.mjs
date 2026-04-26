// End-to-end smoke test: mock WordPress REST API, drive `wpsync init` + `pull` + `push`
// + `status`, and assert no-op behaviors, round-trip integrity, conflict halt, and
// tombstone deletion semantics (PRD §8 acceptance criteria).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const BIN = join(import.meta.dirname, '..', 'packages', 'cli', 'dist', 'bin.js');

const requestLog = [];

function makePost(over = {}) {
  return {
    id: 1,
    type: 'post',
    slug: 'hello-world',
    status: 'publish',
    date_gmt: '2025-01-01T00:00:00',
    modified_gmt: '2025-01-02T00:00:00',
    title: { raw: 'Hello World', rendered: '' },
    content: { raw: '<!-- wp:p --><p>verbatim body</p><!-- /wp:p -->', rendered: '' },
    excerpt: { raw: '', rendered: '' },
    categories: [7],
    tags: [],
    featured_media: 0,
    ...over,
  };
}

const POSTS = [makePost()];

function setHeaders(res, body, headers = {}) {
  const count = Array.isArray(body) ? body.length : 1;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-WP-Total': String(count),
    'X-WP-TotalPages': '1',
    ...headers,
  });
  res.end(body !== undefined ? JSON.stringify(body) : '');
}

function filterByModifiedAfter(items, url) {
  const after = url.searchParams.get('modified_after');
  if (!after) return items;
  return items.filter((p) => Date.parse(p.modified_gmt + 'Z') > Date.parse(after));
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function nowGmt() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = url.pathname;
  requestLog.push({ method: req.method, path: m, search: url.search });

  if (m === '/wp-json/wp/v2/users/me') return setHeaders(res, { id: 1, slug: 'alice' });
  if (m === '/wp-json/wp/v2/categories')
    return setHeaders(res, [{ id: 7, slug: 'research', name: 'Research' }]);
  if (m === '/wp-json/wp/v2/tags') return setHeaders(res, []);

  if (m === '/wp-json/wp/v2/posts') {
    if (req.method === 'GET') return setHeaders(res, filterByModifiedAfter(POSTS, url));
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const next = makePost({
        id: POSTS.length + 1,
        slug: body.slug ?? `new-${Date.now()}`,
        status: body.status ?? 'publish',
        title: { raw: body.title ?? '', rendered: '' },
        content: { raw: body.content ?? '', rendered: '' },
        excerpt: { raw: body.excerpt ?? '', rendered: '' },
        categories: body.categories ?? [],
        tags: body.tags ?? [],
        featured_media: body.featured_media ?? 0,
        date_gmt: body.date_gmt ?? nowGmt(),
        modified_gmt: nowGmt(),
      });
      POSTS.push(next);
      return setHeaders(res, next);
    }
  }

  const idMatch = m.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const idx = POSTS.findIndex((p) => p.id === id);
    if (idx === -1) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      POSTS[idx] = makePost({
        ...POSTS[idx],
        ...(body.title !== undefined ? { title: { raw: body.title, rendered: '' } } : {}),
        ...(body.content !== undefined ? { content: { raw: body.content, rendered: '' } } : {}),
        ...(body.excerpt !== undefined ? { excerpt: { raw: body.excerpt, rendered: '' } } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.categories !== undefined ? { categories: body.categories } : {}),
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
        modified_gmt: nowGmt(),
      });
      return setHeaders(res, POSTS[idx]);
    }
    if (req.method === 'DELETE') {
      // Trash semantics — flip status, keep the row in memory (not force-deleted).
      POSTS[idx] = { ...POSTS[idx], status: 'trash', modified_gmt: nowGmt() };
      return setHeaders(res, POSTS[idx]);
    }
  }

  if (m === '/wp-json/wp/v2/pages') return setHeaders(res, []);

  res.writeHead(404).end();
});

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
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
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const url = await listen();
  const root = await mkdtemp(join(tmpdir(), 'wpsync-smoke-'));
  console.log(`mock WP at ${url}`);
  console.log(`temp root  ${root}`);

  const env = {
    WPSYNC_SITE_URL: url,
    WPSYNC_USERNAME: 'alice',
    WPSYNC_PASSWORD: 'app-password',
  };

  // 1. init + first pull
  let r = await runCli(root, ['init', url], env);
  assert(r.code === 0, `init exit ${r.code}: ${r.stderr}`);

  r = await runCli(root, ['pull', '--verbose'], env);
  assert(r.code === 0, `pull exit ${r.code}: ${r.stderr}`);
  assert(r.stdout.includes('Pulled 1 item'), 'first pull should write 1 item');

  const filePath = join(root, 'posts', 'hello-world.html');
  const original = await fs.readFile(filePath, 'utf8');
  assert(
    original.includes('<!-- wp:p --><p>verbatim body</p><!-- /wp:p -->'),
    'verbatim body missing from pulled file',
  );

  // 2. push with no edits is a no-op
  const beforeStat = await fs.stat(filePath);
  r = await runCli(root, ['push', '--verbose'], env);
  assert(r.code === 0, `idle push exit ${r.code}: ${r.stderr}`);
  assert(r.stdout.includes('Pushed 0 items'), `idle push not no-op: ${r.stdout}`);
  const afterStat = await fs.stat(filePath);
  assert(afterStat.mtimeMs === beforeStat.mtimeMs, 'idle push touched mtime');

  // 3. edit + push updates server
  const edited = original.replace(
    '<!-- wp:p --><p>verbatim body</p><!-- /wp:p -->',
    '<!-- wp:p --><p>locally edited body</p><!-- /wp:p -->',
  );
  await fs.writeFile(filePath, edited, 'utf8');
  const future = Date.now() / 1000 + 60;
  await fs.utimes(filePath, future, future);

  r = await runCli(root, ['push', '--verbose'], env);
  assert(r.code === 0, `push (edit) exit ${r.code}: ${r.stderr}`);
  assert(r.stdout.includes('Pushed 1 item'), 'push should write 1 item');

  // 4. push again — no-op (mtime aligned)
  r = await runCli(root, ['push'], env);
  assert(r.code === 0, `re-push exit ${r.code}: ${r.stderr}`);
  assert(r.stdout.includes('Pushed 0 items'), `re-push not no-op: ${r.stdout}`);

  // 5. round-trip body identity across full pull
  const beforePull = await fs.readFile(filePath, 'utf8');
  r = await runCli(root, ['pull', '--full'], env);
  assert(r.code === 0, `full pull exit ${r.code}: ${r.stderr}`);
  const afterPull = await fs.readFile(filePath, 'utf8');
  const bodyOf = (s) => s.split('\n---\n\n').slice(1).join('\n---\n\n');
  assert(bodyOf(beforePull) === bodyOf(afterPull), 'round-trip body changed');
  assert(afterPull.includes('locally edited body'), 'edited body lost in round-trip');

  // 6. CONFLICT HALT — both sides change → exit 4 with no writes
  // Edit the local file
  const conflictedLocal = afterPull.replace(
    'locally edited body',
    'about to lose this if we resolve via --force-pull',
  );
  await fs.writeFile(filePath, conflictedLocal, 'utf8');
  await fs.utimes(filePath, future + 120, future + 120);
  // Mutate server-side directly. Use a far-future timestamp to dodge the mock's
  // second-precision clock — otherwise this can race the push timestamp.
  POSTS[0] = makePost({
    ...POSTS[0],
    content: { raw: 'server-side change', rendered: '' },
    modified_gmt: '2030-01-01T00:00:00',
  });
  // First, status should report a conflict
  r = await runCli(root, ['status'], env);
  assert(r.code === 0, `status exit ${r.code}: ${r.stderr}`);
  assert(
    r.stdout.includes('Conflicts (both sides changed)'),
    `status missing conflicts section: ${r.stdout}`,
  );

  const requestsBefore = requestLog.length;
  r = await runCli(root, ['pull'], env);
  assert(r.code === 4, `expected exit 4 on conflict, got ${r.code}: ${r.stderr}`);
  const localAfterHalt = await fs.readFile(filePath, 'utf8');
  assert(
    localAfterHalt === conflictedLocal,
    'local file modified despite conflict halt',
  );
  // Push side should also halt
  r = await runCli(root, ['push'], env);
  assert(r.code === 4, `push expected exit 4 on conflict, got ${r.code}: ${r.stderr}`);
  // Sanity: only listing GETs since the halt — no POST/PUT
  const newCalls = requestLog.slice(requestsBefore);
  for (const call of newCalls) {
    assert(call.method === 'GET', `conflict halt issued ${call.method} ${call.path}`);
  }

  // 7. Resolve with --force-pull — server wins
  r = await runCli(root, ['pull', '--force-pull'], env);
  assert(r.code === 0, `force-pull exit ${r.code}: ${r.stderr}`);
  const resolved = await fs.readFile(filePath, 'utf8');
  assert(resolved.includes('server-side change'), 'force-pull did not overwrite local');

  // 8. TOMBSTONE — set status: trash, push, expect DELETE without force=true
  const trashed = resolved.replace('status: publish', 'status: trash');
  await fs.writeFile(filePath, trashed, 'utf8');
  await fs.utimes(filePath, Date.now() / 1000 + 240, Date.now() / 1000 + 240);

  const beforeDelete = requestLog.length;
  r = await runCli(root, ['push', '--verbose'], env);
  assert(r.code === 0, `tombstone push exit ${r.code}: ${r.stderr}`);
  // Local file must be removed
  await fs
    .access(filePath)
    .then(() => {
      throw new Error('local file should have been removed after tombstone push');
    })
    .catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  // Verify the DELETE call landed and didn't carry force=true
  const sinceTombstone = requestLog.slice(beforeDelete);
  const deletes = sinceTombstone.filter((c) => c.method === 'DELETE');
  assert(deletes.length === 1, `expected 1 DELETE, got ${deletes.length}`);
  assert(
    !deletes[0].search.includes('force'),
    `DELETE included a force flag: ${deletes[0].search}`,
  );

  await rm(root, { recursive: true, force: true });
  server.close();
  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
