// Orchestrate `electron-builder --win` on Windows.
//
// `builder-util` (which electron-builder uses to spawn `app-builder`) computes
// `SZA_PATH` from `7zip-bin.path7za` and overrides whatever env we pass. The
// only reliable way to inject our extract-time `-xr!darwin` flag is to replace
// the bundled `7za.exe` itself with a tiny C# shim that proxies to the real
// 7za and appends the exclude flag for extract operations.
//
// Why we need this: the winCodeSign-2.6.0.7z archive electron-builder pulls
// for Windows targets contains macOS dylib symlinks. Creating symlinks on
// Windows requires admin or Developer Mode, so 7za extract bails with
// "A required privilege is not held by the client" and the build dies.
// Skipping the entire darwin/ subtree lets the cache populate cleanly with
// only the Windows tools we actually need.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '..');
const SHIM_PATH = join(__dirname, '7za-shim', '7za.exe');

// Resolve the bundled 7za via the same module electron-builder uses, rather
// than hardcoding the pnpm-store path, so a `7zip-bin` version bump (or a
// switch to npm/yarn) doesn't silently break this. `7zip-bin` is a transitive
// dep of electron-builder, so we resolve from there.
function resolve7zaBinDir() {
  // electron-builder is a direct devDep, and pulls in 7zip-bin transitively.
  // Resolve from electron-builder's location so the actual hoisted path works
  // regardless of pnpm-store version directory changes.
  const requireFromGui = createRequire(join(PKG_DIR, 'package.json'));
  const electronBuilderPkg = requireFromGui.resolve('electron-builder/package.json');
  const requireFromBuilder = createRequire(electronBuilderPkg);
  const path7za = requireFromBuilder('7zip-bin').path7za;
  return dirname(path7za);
}

const SEVENZIP_BIN_DIR = resolve7zaBinDir();
const BUNDLED_7ZA = join(SEVENZIP_BIN_DIR, '7za.exe');
const REAL_7ZA = join(SEVENZIP_BIN_DIR, 'real-7za.exe');

const SHIM_MARKER = 'wpsync-7za-shim'; // we tag a sibling file so we can detect prior patching

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, env) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: PKG_DIR,
    env: env ?? process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function ensurePatched7za() {
  // Idempotent: if we already moved the bundled 7za to real-7za.exe and put
  // our shim in its place, do nothing.
  const markerPath = join(SEVENZIP_BIN_DIR, '.wpsync-shim-installed');
  if ((await exists(markerPath)) && (await exists(REAL_7ZA))) {
    return;
  }

  // If a previous run left things in a broken state, restore the real 7za
  // before re-patching.
  if (await exists(REAL_7ZA)) {
    await fs.copyFile(REAL_7ZA, BUNDLED_7ZA);
  }

  if (!(await exists(BUNDLED_7ZA))) {
    throw new Error(`bundled 7za not found at ${BUNDLED_7ZA} — run pnpm install first.`);
  }

  console.log(`patch-7za: archiving original to ${REAL_7ZA}`);
  await fs.copyFile(BUNDLED_7ZA, REAL_7ZA);

  console.log(`patch-7za: installing shim from ${SHIM_PATH}`);
  await fs.copyFile(SHIM_PATH, BUNDLED_7ZA);

  await fs.writeFile(markerPath, SHIM_MARKER + '\n', 'utf8');
}

async function main() {
  if (process.platform !== 'win32') {
    console.warn('dist-win: not on Windows; running electron-builder directly.');
    run('pnpm', ['build'], process.env);
    const eb = join(PKG_DIR, 'node_modules', '.bin', 'electron-builder');
    run(eb, ['--win'], process.env);
    return;
  }

  // 1. Build (electron tsc + vite renderer)
  run('pnpm', ['build'], process.env);

  // 2. Compile the shim if needed.
  run('node', [join(__dirname, 'build-7za-shim.mjs')], process.env);
  if (!(await exists(SHIM_PATH))) {
    throw new Error(`7za shim missing at ${SHIM_PATH}`);
  }

  // 3. Replace bundled 7za with the shim (idempotent).
  await ensurePatched7za();

  // 4. Run electron-builder. The shim will see WPSYNC_REAL_7ZA and forward
  //    every call to the original binary, appending -xr!darwin for extracts.
  const env = { ...process.env };
  env['WPSYNC_REAL_7ZA'] = REAL_7ZA;
  env['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false';

  const eb = join(PKG_DIR, 'node_modules', '.bin', 'electron-builder.cmd');
  run(eb, ['--win'], env);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
