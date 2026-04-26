// Compile scripts/7za-shim/7za-shim.cs into 7za.exe using the .NET Framework
// C# compiler that ships with every Windows install. Output lands at
// scripts/7za-shim/7za.exe and is invoked by electron-builder via SZA_PATH.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = join(__dirname, '7za-shim');
const CS_PATH = join(SHIM_DIR, '7za-shim.cs');
const EXE_PATH = join(SHIM_DIR, '7za.exe');

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findCsc() {
  for (const c of CSC_CANDIDATES) {
    if (await exists(c)) return c;
  }
  return null;
}

async function shouldRebuild() {
  if (!(await exists(EXE_PATH))) return true;
  const exeStat = await fs.stat(EXE_PATH);
  const srcStat = await fs.stat(CS_PATH);
  return srcStat.mtimeMs > exeStat.mtimeMs;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('build-7za-shim: not on Windows, skipping');
    return;
  }
  if (!(await shouldRebuild())) {
    console.log(`build-7za-shim: ${EXE_PATH} is up to date`);
    return;
  }
  const csc = await findCsc();
  if (!csc) {
    throw new Error(
      'build-7za-shim: could not find csc.exe. Install .NET Framework 4.x or run on a CI Windows runner that has it preinstalled.',
    );
  }
  await fs.mkdir(SHIM_DIR, { recursive: true });
  console.log(`build-7za-shim: compiling ${CS_PATH} → ${EXE_PATH}`);
  const result = spawnSync(csc, ['/nologo', '/target:exe', `/out:${EXE_PATH}`, CS_PATH], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`csc exited with status ${result.status}`);
  }
  console.log('build-7za-shim: done');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
