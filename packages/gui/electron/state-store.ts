import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { app } from 'electron';

interface PersistedState {
  rootDir: string | null;
}

const FILE = 'wpsync-app.json';

function statePath(): string {
  return join(app.getPath('userData'), FILE);
}

export async function loadAppState(): Promise<PersistedState> {
  try {
    const text = await fs.readFile(statePath(), 'utf8');
    const parsed = JSON.parse(text) as Partial<PersistedState>;
    return { rootDir: typeof parsed.rootDir === 'string' ? parsed.rootDir : null };
  } catch {
    return { rootDir: null };
  }
}

export async function saveAppState(state: PersistedState): Promise<void> {
  const path = statePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
