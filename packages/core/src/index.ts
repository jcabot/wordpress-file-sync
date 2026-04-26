export const VERSION = '0.0.0';

export { createSyncSession } from './session.js';
export type { SyncSession, SyncSessionOptions } from './session.js';

export { createCredentialStore } from './credentials.js';
export type { CredentialStore } from './credentials.js';

export {
  loadConfig,
  saveConfig,
  parseConfig,
  ensureConfigDir,
  loadState,
  saveState,
  EMPTY_STATE,
} from './state.js';

export { encode as encodeFrontMatter, decode as decodeFrontMatter } from './frontmatter.js';

export {
  configDir,
  configPath,
  statePath,
  taxonomyPath,
  gitignorePath,
  typeDir,
  postFilePath,
} from './paths.js';

export { AuthError, ConflictError, TransportError, UsageError, WpsyncError } from './errors.js';

export { TypedEmitter } from './events.js';
export type { SyncEvents } from './events.js';

export type {
  Config,
  Credentials,
  FrontMatter,
  PostType,
  PostStatus,
  RestItem,
  State,
  TaxonomyTerm,
} from './types.js';

export type {
  PullOptions,
  PullResult,
  ConflictResolution,
  ConflictResolutions,
} from './pull.js';
export type { PushOptions, PushResult } from './push.js';
export type { StatusOptions, StatusResult, StatusEntry, EntryState } from './status.js';
