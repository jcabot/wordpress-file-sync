import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface PersistedAppState {
  rootDir: string | null;
}

function appStatePath(): string {
  return join(homedir(), '.wpsync', 'app-state.json');
}

export async function loadAppState(): Promise<PersistedAppState> {
  try {
    const text = await fs.readFile(appStatePath(), 'utf8');
    const parsed = JSON.parse(text) as Partial<PersistedAppState>;
    return { rootDir: typeof parsed.rootDir === 'string' ? parsed.rootDir : null };
  } catch {
    return { rootDir: null };
  }
}

export async function saveAppState(state: PersistedAppState): Promise<void> {
  const path = appStatePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
