import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import TOML from '@iarna/toml';
import type { Config, State } from './types.js';
import { configDir, configPath, statePath } from './paths.js';

async function atomicWrite(path: string, data: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, path);
}

export async function ensureConfigDir(rootDir: string): Promise<void> {
  await fs.mkdir(configDir(rootDir), { recursive: true });
}

export async function loadConfig(rootDir: string): Promise<Config> {
  let text: string;
  try {
    text = await fs.readFile(configPath(rootDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No .wpsync/config.toml found in ${rootDir}. Run \`wpsync init\` first.`,
      );
    }
    throw err;
  }
  const parsed = TOML.parse(text) as Record<string, unknown>;
  return parseConfig(parsed);
}

export function parseConfig(raw: Record<string, unknown>): Config {
  const siteUrl = raw['site_url'];
  const contentDir = raw['content_dir'];
  const enabledTypes = raw['enabled_types'];
  const username = raw['username'];
  if (typeof siteUrl !== 'string' || siteUrl === '') {
    throw new Error('config: site_url must be a non-empty string');
  }
  if (typeof contentDir !== 'string' || contentDir === '') {
    throw new Error('config: content_dir must be a non-empty string');
  }
  if (typeof username !== 'string' || username === '') {
    throw new Error('config: username must be a non-empty string');
  }
  if (!Array.isArray(enabledTypes) || enabledTypes.length === 0) {
    throw new Error('config: enabled_types must be a non-empty array');
  }
  for (const t of enabledTypes) {
    if (t !== 'post' && t !== 'page') {
      throw new Error(`config: enabled_types contains unsupported value "${String(t)}"`);
    }
  }
  return {
    site_url: siteUrl,
    content_dir: contentDir,
    enabled_types: enabledTypes as Config['enabled_types'],
    username,
  };
}

export async function saveConfig(rootDir: string, config: Config): Promise<void> {
  const text = TOML.stringify({
    site_url: config.site_url,
    content_dir: config.content_dir,
    enabled_types: config.enabled_types,
    username: config.username,
  });
  await atomicWrite(configPath(rootDir), text);
}

export const EMPTY_STATE: State = { schema_version: 1, last_sync: null };

export async function loadState(rootDir: string): Promise<State> {
  try {
    const text = await fs.readFile(statePath(rootDir), 'utf8');
    const raw = JSON.parse(text) as Record<string, unknown>;
    const lastSync = raw['last_sync'];
    return {
      schema_version: 1,
      last_sync: typeof lastSync === 'string' ? lastSync : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE };
    throw err;
  }
}

export async function saveState(rootDir: string, state: State): Promise<void> {
  await atomicWrite(statePath(rootDir), JSON.stringify(state, null, 2) + '\n');
}
