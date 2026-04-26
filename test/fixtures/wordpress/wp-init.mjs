// Idempotent WordPress fixture provisioning. Brings up docker-compose, waits
// for WP to respond, installs it (admin user "alice"), generates an
// Application Password, and seeds at least 105 posts so the >= 101 pagination
// AC has something to walk over.
//
// Re-running is cheap: each step is a no-op when its result is already
// present, so test iterations stay fast.
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');
const APP_PASS_FILE = join(__dirname, 'app-password.txt');

export const FIXTURE = {
  siteUrl: 'http://localhost:8888',
  username: 'alice',
  adminEmail: 'alice@example.test',
  adminPassword: 'secret',
  composeFile: COMPOSE_FILE,
  appPassFile: APP_PASS_FILE,
  seedSlugPrefix: 'wpsync-seed-',
  seedCount: 105,
};

// Resolve docker once. On Windows, .exe resolution via PATH works without
// `shell: true`, and we MUST avoid `shell: true` because cmd.exe will eat
// `<` / `>` in our wp-cli arguments as redirection operators.
const DOCKER_BIN =
  process.platform === 'win32' ? findDockerExe() : 'docker';

function findDockerExe() {
  const paths = (process.env['PATH'] ?? '').split(';');
  for (const p of paths) {
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
}

function dc(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, ['compose', '-f', COMPOSE_FILE, ...args], {
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    if (opts.capture) {
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.stderr.on('data', (b) => (stderr += b.toString()));
    }
    child.on('close', (code) => {
      if (code === 0 || opts.allowFailure) {
        resolve({ code: code ?? 1, stdout, stderr });
      } else {
        reject(
          new Error(
            `docker compose ${args.join(' ')} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    });
    child.on('error', reject);
  });
}

function wp(args, opts = {}) {
  return dc(
    [
      'run',
      '--rm',
      '-T', // no TTY — needed for non-interactive captures
      'wp-cli',
      'wp',
      ...args,
    ],
    opts,
  );
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWp() {
  const deadline = Date.now() + 180_000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${FIXTURE.siteUrl}/wp-login.php`, { redirect: 'manual' });
      // 200 (login form) or 302 (redirect to install) both mean the server is up
      if (res.status >= 200 && res.status < 400) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(2000);
  }
  throw new Error(`WP did not become reachable within 180s: ${lastErr ?? 'no response'}`);
}

async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureApacheAllowOverride() {
  // The official wordpress:apache image ships with `AllowOverride None`, which
  // means WordPress's .htaccess rewrite rules — including the one that
  // re-injects the `Authorization` header for PHP — are ignored. Without that
  // header, every Application-Password request returns 401. We patch the
  // Apache conf in-place and HUP Apache.
  // Verify the /var/www/ block specifically allows .htaccess overrides.
  const check = await new Promise((resolve, reject) => {
    const child = spawn(
      DOCKER_BIN,
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'wp',
        'sh',
        '-c',
        // Print just the /var/www/ block, then check for "AllowOverride All".
        "awk '/<Directory \\/var\\/www\\/>/,/<\\/Directory>/' /etc/apache2/apache2.conf",
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    );
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.on('close', () => resolve(out));
    child.on('error', reject);
  });
  if (/AllowOverride\s+All/.test(check)) return;
  console.log('wp-init: enabling AllowOverride All so WP .htaccess rules apply…');
  await new Promise((resolve, reject) => {
    const child = spawn(
      DOCKER_BIN,
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        '--user',
        'root',
        'wp',
        'sh',
        '-c',
        // Target only the <Directory /var/www/> block, then HUP Apache.
        "sed -i '/<Directory \\/var\\/www\\/>/,/<\\/Directory>/ s/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf && apache2ctl graceful",
      ],
      { stdio: 'inherit', shell: false },
    );
    child.on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`apache patch exited ${code}`))));
    child.on('error', reject);
  });
}

async function ensureInstalled() {
  const isInstalled = await wp(['core', 'is-installed'], {
    capture: true,
    allowFailure: true,
  });
  if (isInstalled.code !== 0) {
    console.log('wp-init: installing WordPress…');
    await wp([
      'core',
      'install',
      `--url=${FIXTURE.siteUrl}`,
      '--title=wpsync-test',
      `--admin_user=${FIXTURE.username}`,
      `--admin_password=${FIXTURE.adminPassword}`,
      `--admin_email=${FIXTURE.adminEmail}`,
      '--skip-email',
    ]);
  } else {
    console.log('wp-init: WP is already installed');
  }
  // Pretty permalinks must be enabled for /wp-json/* to be reachable through
  // mod_rewrite (default install otherwise returns the homepage HTML).
  const permalink = await wp(['option', 'get', 'permalink_structure'], {
    capture: true,
    allowFailure: true,
  });
  if (permalink.stdout.trim() !== '/%postname%/') {
    console.log('wp-init: enabling pretty permalinks…');
    await wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    await wp(['rewrite', 'flush', '--hard']);
  }
}

async function appPasswordWorks(password) {
  const auth = 'Basic ' + Buffer.from(`${FIXTURE.username}:${password}`).toString('base64');
  try {
    const res = await fetch(`${FIXTURE.siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: auth },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureAppPassword() {
  if (await fileExists(APP_PASS_FILE)) {
    const stored = (await fs.readFile(APP_PASS_FILE, 'utf8')).trim();
    if (stored && (await appPasswordWorks(stored))) {
      console.log('wp-init: stored Application Password is valid');
      return stored;
    }
    console.log('wp-init: stored Application Password is stale, regenerating…');
    // Best-effort revoke any existing app password named "wpsync-test" before we recreate.
    await wp(
      ['user', 'application-password', 'delete', FIXTURE.username, 'wpsync-test'],
      { capture: true, allowFailure: true },
    );
  }
  const result = await wp(
    [
      'user',
      'application-password',
      'create',
      FIXTURE.username,
      'wpsync-test',
      '--porcelain',
    ],
    { capture: true },
  );
  const pw = result.stdout.trim();
  if (!pw) throw new Error('wp-init: failed to capture Application Password from wp-cli');
  await fs.writeFile(APP_PASS_FILE, pw + '\n', 'utf8');
  console.log('wp-init: Application Password created and stored');
  return pw;
}

async function ensureSeedPosts() {
  const list = await wp(
    [
      'post',
      'list',
      '--post_type=post',
      '--post_status=any',
      `--name__like=${FIXTURE.seedSlugPrefix}`,
      '--format=count',
    ],
    { capture: true },
  );
  const have = Number.parseInt(list.stdout.trim(), 10) || 0;
  if (have >= FIXTURE.seedCount) {
    console.log(`wp-init: ${have} seed posts already present (>= ${FIXTURE.seedCount})`);
    return;
  }

  const need = FIXTURE.seedCount - have;
  console.log(`wp-init: seeding ${need} posts (have ${have}, need ${FIXTURE.seedCount})…`);

  // Generate posts one batch at a time. wp post generate uses random slugs, so
  // we can't predict them — for the pagination test we only need >= 101 posts
  // total with the seed prefix. Use `wp post create` with explicit slugs so
  // the slugs are deterministic.
  for (let i = have + 1; i <= FIXTURE.seedCount; i += 1) {
    const slug = `${FIXTURE.seedSlugPrefix}${String(i).padStart(3, '0')}`;
    await wp([
      'post',
      'create',
      `--post_title=seed-${i}`,
      `--post_name=${slug}`,
      '--post_status=publish',
      '--post_type=post',
      `--post_content=<!-- wp:paragraph --><p>seed-body-${i}</p><!-- /wp:paragraph -->`,
    ]);
  }
  console.log(`wp-init: seeded ${need} posts`);
}

export async function setupFixture() {
  // `up -d db wp` brings them up but the wp-cli profile is left dormant.
  await dc(['up', '-d', 'db', 'wp']);
  await waitForWp();
  await ensureInstalled();
  await ensureApacheAllowOverride();
  const appPassword = await ensureAppPassword();
  await ensureSeedPosts();
  return { appPassword };
}

export async function teardownFixture(opts = { volumes: false }) {
  await dc(['down', ...(opts.volumes ? ['-v'] : [])], { allowFailure: true });
}

// Allow standalone invocation: `node wp-init.mjs` from any cwd.
const isCli = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wp-init.mjs');
  } catch {
    return false;
  }
})();

if (isCli) {
  setupFixture().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Suppress unused-import warning for spawnSync in environments that lint imports.
void spawnSync;
