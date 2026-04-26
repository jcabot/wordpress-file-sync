import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, accessSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');
const COMPOSE_FILE = join(REPO_ROOT, 'test', 'fixtures', 'wordpress', 'docker-compose.yml');
const APP_PASS_FILE = join(REPO_ROOT, 'test', 'fixtures', 'wordpress', 'app-password.txt');

export const FIXTURE = {
  siteUrl: 'http://localhost:8888',
  username: 'alice',
  seedSlugPrefix: 'wpsync-seed-',
};

const DOCKER_BIN = (() => {
  if (process.platform !== 'win32') return 'docker';
  for (const p of (process.env['PATH'] ?? '').split(';')) {
    if (!p) continue;
    const candidate = join(p, 'docker.exe');
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return 'docker';
})();

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let cachedPassword: string | null = null;

export async function readAppPassword(): Promise<string> {
  if (cachedPassword) return cachedPassword;
  cachedPassword = (await fs.readFile(APP_PASS_FILE, 'utf8')).trim();
  return cachedPassword;
}

export async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wpsync-it-'));
}

export async function disposeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const password = await readAppPassword();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        WPSYNC_USERNAME: FIXTURE.username,
        WPSYNC_PASSWORD: password,
        WPSYNC_SITE_URL: FIXTURE.siteUrl,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', reject);
  });
}

export async function initRoot(): Promise<string> {
  const root = await makeRoot();
  const res = await runCli(root, ['init', FIXTURE.siteUrl]);
  if (res.code !== 0) {
    throw new Error(`init failed (${res.code}): ${res.stderr}\n${res.stdout}`);
  }
  return root;
}

export interface WpCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function wpCli(args: string[]): Promise<WpCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      DOCKER_BIN,
      ['compose', '-f', COMPOSE_FILE, 'run', '--rm', '-T', 'wp-cli', 'wp', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', reject);
  });
}

export async function wpCliCheck(args: string[]): Promise<string> {
  const r = await wpCli(args);
  if (r.code !== 0) {
    throw new Error(`wp ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  }
  return r.stdout;
}

export async function readPostFile(root: string, type: 'post' | 'page', slug: string): Promise<string> {
  const dir = type === 'post' ? 'posts' : 'pages';
  return fs.readFile(join(root, dir, `${slug}.html`), 'utf8');
}

export async function postFileExists(root: string, type: 'post' | 'page', slug: string): Promise<boolean> {
  const dir = type === 'post' ? 'posts' : 'pages';
  try {
    await fs.access(join(root, dir, `${slug}.html`));
    return true;
  } catch {
    return false;
  }
}

export function frontmatterAndBody(text: string): { meta: string; body: string } {
  const start = text.indexOf('---\n');
  const end = text.indexOf('\n---\n', start + 4);
  if (start !== 0 || end === -1) throw new Error('no front-matter fences found');
  const meta = text.slice(4, end + 1);
  const body = text.slice(end + 5).replace(/^\n/, '');
  return { meta, body };
}

// Suppress unused-import warning where applicable.
void spawnSync;
