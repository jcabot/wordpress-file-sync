# CLAUDE.md — `wpsync`

Engineering context for Claude sessions working on this repo. User-facing docs live in `README.md`.

## What this project is

`wpsync` — a CLI + Electron GUI tool that performs **incremental, bidirectional sync** between a WordPress site and a local directory via the WP REST API. Posts are stored on disk as raw `post_content` (Gutenberg block markup, shortcodes, HTML — verbatim, no transformation) wrapped in YAML front-matter, so they're editable in any text editor and Git-trackable.

Single-user, single-site, scriptable. Greenfield TypeScript codebase.

## Source-of-truth documents

- **PRD:** `C:\Users\jordi.cabot\Downloads\prd-wp-local-sync (1).md` — authoritative for endpoints, file format, CLI surface, GUI states, exit codes, conflict semantics, tombstone deletions, decision log. Read before making design decisions.
- **Implementation plan:** `C:\Users\jordi.cabot\.claude\plans\indexed-launching-dragonfly.md` — workspace layout, module breakdown, milestones, open risks. The plan was approved on 2026-04-26.

## Confirmed scope decisions (do not re-litigate)

- Ship **CLI and Electron GUI together** in v1 — not phased.
- **pnpm workspaces** monorepo (not Turborepo, not single package).
- Integration tests run against a **Docker Compose WordPress + MariaDB** fixture.
- **TypeScript** across all packages; **commander** for CLI; **React + Vite** for GUI renderer; **vitest** as the only test runner.
- **`keytar`** for credential storage, with an AES-GCM fallback when the OS keychain is unavailable.

## Workspace layout

```
packages/
├── core/           # @wpsync/core — sync library (no Node-CLI/Electron deps)
├── cli/            # @wpsync/cli  — bin: wpsync (commander)
└── gui/            # @wpsync/gui  — Electron main + React renderer
test/
├── fixtures/wordpress/   # docker-compose.yml + wp-init.sh seeding 105 posts
└── integration/          # cross-package end-to-end tests
```

Composite TS project references (`tsconfig.base.json`) so GUI imports `@wpsync/core` as **TypeScript source**, not a built artefact (PRD §10 requires no subprocess/IPC between GUI and sync logic — main↔renderer IPC inside Electron is fine and unavoidable).

## `@wpsync/core` public API (consumed identically by CLI and GUI)

```ts
export function createSyncSession(cfg: Config, creds: Credentials): SyncSession;
// session.pull(opts), session.push(opts), session.status(), session.testAuth(), session.events

export interface SyncEvents {
  start:    { op: 'pull'|'push'; total?: number };
  item:     { op: 'pull'|'push'; slug: string; index: number; total: number;
              action: 'create'|'update'|'delete'|'skip' };
  conflict: { slugs: string[] };
  done:     { op: 'pull'|'push'; written: number; skipped: number };
  log:      { level: 'info'|'warn'|'error'; msg: string };
}
```

CLI and GUI both subscribe to `session.events`. CLI pipes them to stdout (verbose/quiet renderers); GUI re-emits over `ipcRenderer` from main → renderer.

## Module map (`packages/core/src/`)

| File | Responsibility |
|---|---|
| `rest-client.ts` | `fetch` wrapper, Basic Auth, **always `context=edit`**, `Link: rel="next"` paginator with fallback to `X-WP-TotalPages` + `?page=N`, retry-once on 5xx, `AuthError`/`TransportError` mapping |
| `frontmatter.ts` | `encode`/`decode` via `yaml` package |
| `paths.ts` | slug→filename, type→subdir, `.wpsync/*` resolution |
| `state.ts` | Atomic temp+rename writes for `.wpsync/state.json` and `.wpsync/config.toml` (`@iarna/toml`) |
| `taxonomy-cache.ts` | Lazy-load categories/tags, persist to `.wpsync/taxonomy.json` |
| `mapper.ts` | `restItemToFrontmatter` and inverse; ID↔slug taxonomy resolution |
| `pull.ts` | `modified_after` query, paginate, write files, advance `last_sync` to **max** observed `modified_gmt` |
| `push.ts` | Walk dir, decode, compare `mtime` vs front-matter `modified_gmt`, POST/create, write back |
| `conflict.ts` | Pure detector; runs **before any writes** |
| `tombstone.ts` | `status: trash` → `DELETE /wp/v2/<type>/<id>` **without `force`** (PRD §4.5, §8 AC) |
| `events.ts` | Strongly-typed `EventEmitter<SyncEvents>` |
| `errors.ts` | `AuthError`, `ConflictError(slugs)`, `TransportError`, `UsageError` |

## Critical conventions and invariants

These are not negotiable — they come from the PRD and breaking them violates acceptance criteria:

1. **Verbatim `post_content`.** Body is `content.raw` written byte-for-byte; never transform, normalise whitespace, or re-render. Round-trip integrity AC depends on this (PRD §4.1, §8).
2. **`context=edit` always** on posts/pages REST queries (PRD §6) — without it the API returns `content.rendered`, breaking round-trip.
3. **DELETE never sends `force=true`.** Trashes only; permanent deletion is a wp-admin-only action. Verifiable by HTTP capture (PRD §4.5, §8 AC).
4. **Plain `rm` is not a deletion.** A removed file is re-pulled on next sync. Tombstone deletion = set `status: trash` in front-matter and push.
5. **Credentials never leave the keychain.** No password in `state.json`, `config.toml`, log output, or any Git-tracked file (PRD §8 AC).
6. **Conflict halt = zero writes.** When both sides have changed since `last_sync`, exit code 4, name affected slugs, no file or API writes happen.
7. **Always print `<type>/<slug>`** in conflict reports — slugs can collide across `posts/` and `pages/`.

## Time and mtime semantics

- WP `*_gmt` fields are GMT but emitted **without** the `Z` suffix. Always parse as `new Date(s + 'Z')`.
- File `mtime` comparison uses a **2-second tolerance**: `fileMtime > Date.parse(modified_gmt+'Z') + 2000`. WP precision is 1s; writing the file after a push leaves `mtime` slightly ahead of the server's value.
- After a successful push, rewrite the file with new front-matter (preserving body byte-for-byte) and **`fs.utimes` the `mtime` to the parsed server `modified_gmt`** so the very next push sees no diff.

## Conflict detection algorithm

```
serverModGmt = item.modified_gmt          // from REST listing
localModGmt  = frontmatter.modified_gmt   // last known server value at last pull/push
fileMtime    = stat(file).mtimeMs

serverChanged = Date.parse(serverModGmt+'Z') > Date.parse(localModGmt+'Z')
localChanged  = fileMtime > Date.parse(localModGmt+'Z') + 2000
if (serverChanged && localChanged) → conflict
```

`--force-pull` skips `localChanged`; `--force-push` skips `serverChanged`. GUI conflict modal collects per-slug overrides and calls core with explicit `{slug → keep-local|keep-server|skip}`. New files (no `id`) are never in conflict; tombstones bypass the check.

## Auth & secrets

- `keytar` service `wpsync`, account `<site-url>`. Stores Application Password only.
- `.wpsync/config.toml`: site URL, content dir, enabled types, **username** (Git-safe).
- `.wpsync/state.json`: `last_sync`, schema version. Never credentials.
- Fallback when keytar unavailable: `.wpsync/secrets.json`, `chmod 600`, AES-GCM with a key scrypt-derived from `os.hostname() + os.userInfo().username`. `init` writes a `.gitignore` that excludes `secrets.json`.

## Front-matter schema (PRD §5)

```yaml
id: number              # absent for new local files
type: 'post' | 'page'
slug: string
title: string
status: publish|draft|pending|private|future|trash
categories: [slug, ...] # posts only
tags: [slug, ...]       # posts only
featured_media: number  # 0 if none
excerpt: string
date_gmt: string        # ISO-8601 naive (no offset)
modified_gmt: string    # ISO-8601 naive — last known server value
parent: number          # pages only, 0 = top-level
```

## CLI exit codes (PRD §9)

| Code | Meaning |
|------|---------|
| 0 | Success or no-op |
| 1 | Generic error |
| 2 | Usage error (`commander.CommanderError`) |
| 3 | Auth failure (401/403) |
| 4 | Conflict detected — zero writes |
| 5 | Network / transport error |

Mapped in the CLI's top-level catch in `packages/cli/src/bin.ts`.

## Test strategy

- **Unit:** `packages/*/src/**/*.test.ts` with mocked `fetch`. Cover front-matter round-trip, mapper ID↔slug, conflict matrix (4 cases × force flags), Link-header pagination parser, exit-code mapping.
- **Integration:** `test/integration/src/*.test.ts` — runs as a separate workspace package (`@wpsync/test-integration`) so it doesn't get pulled into `pnpm test`. `vitest globalSetup` calls `setupFixture()` from `test/fixtures/wordpress/wp-init.mjs` which: brings up `db` + `wp` via `docker compose`, polls `/wp-login.php` until reachable, runs `wp core install` (admin user `alice`, password `secret`), enables pretty permalinks, **patches `AllowOverride None` → `All` in the container's `apache2.conf`** so WP's `.htaccess` `Authorization`-header rewrite takes effect, generates an Application Password into `test/fixtures/wordpress/app-password.txt`, and seeds 105 posts with deterministic slugs (`wpsync-seed-001` … `wpsync-seed-105`). Tests drive the **real** `packages/cli/dist/bin.js` as a child process (same pattern as `scripts/smoke.mjs`). Vitest is configured single-fork, sequential — the fixture is shared. Four ACs:
  - `pull-roundtrip.test.ts` — pull a seed post, edit body, push, full-pull again, assert post-push body == post-pull body
  - `pull-pagination.test.ts` — fresh init + `pull --full --type post`, assert ≥101 seed files in `posts/` (the per_page=100 cap means this requires ≥2 page fetches)
  - `conflict-halt.test.ts` — pull a seed post, edit local + bump mtime, mutate server-side via `wp-cli`, assert `pull` and `push` both exit 4, the local file is untouched, and the server's title hasn't changed
  - `tombstone-no-force.test.ts` — create a fresh `wpsync-tomb-<uuid>` server-side, pull, set `status: trash` locally, push, assert local file gone + server post in `trash` status, then `wp post update --post_status=draft` succeeds (proving the row wasn't `force`-deleted)
- **CI:** Docker integration runs on `ubuntu-latest` only (Windows runners are flaky for Docker); unit tests on `{ubuntu, windows, macos}` matrix to cover `keytar`.

## Implementation milestones

1. ✅ **M1 — Skeleton.** pnpm workspace, three packages, tsconfig refs, vitest, lint, CI green.
2. ✅ **M2 — Read-only pull.** Core: errors, events (TypedEmitter over a `type` alias, not `interface`), types, paths, frontmatter (YAML codec with `schema: 'core'` so date strings stay strings), state (TOML config, atomic temp+rename), credentials (keytar + AES-GCM file fallback), rest-client (Basic Auth, `context=edit`, dual-strategy paginator: Link header → X-WP-TotalPages, retry-once on 5xx **for GETs only**), taxonomy-cache, mapper, pull (with `modified_after` and Z-suffix appending; aligns file `mtime` to server `modified_gmt` after each write so a subsequent push is a no-op), session. CLI: `commander`-driven bin with `init` / `auth set|test|clear` / `pull --full --type --dry-run`, exit-code mapping, friendly "no config" error.
3. ✅ **M3 — Push.** `rest-client.createItem`/`updateItem` (POST, **no retry** because non-idempotent), `taxonomy-cache.idBySlug`, `mapper.frontmatterToPayload` (UsageError on unknown taxonomy slug), `push.ts` (walks `posts/`+`pages/`, classifies create/update/skip with 2-second mtime tolerance, writes back front-matter, `fs.utimes` mtime to server `modified_gmt`), CLI `push --type --dry-run`. End-to-end smoke at `scripts/smoke.mjs` covers idle push no-op, edit-and-push, re-push no-op, and pull→push→pull byte-identity (PRD §8 round-trip AC).
4. ✅ **M4 — Conflict + tombstone + status.** `conflict.ts` (pure detector with 2-second `mtime` tolerance), `rest-client.deleteItem` (DELETE without `force=true`, no retry — never sends `force=true` is verified by URL inspection), tombstone branch in `push.ts` (`status: trash` → DELETE then `fs.unlink`; no-id trash just unlinks), conflict pre-pass in `pull.ts` (buffers all items, halts before any writes), conflict pre-pass in `push.ts` (uses listing `modified_after=last_sync` to detect server-side changes), `status.ts` aggregating per-slug `pending-pull`/`pending-push`/`conflict`/`tombstone`/`new-local`/`up-to-date`, CLI `status` command + `--force-pull` / `--force-push`. **bin.ts uses `process.exitCode` instead of `process.exit()`** — `process.exit()` was racing libuv async handles on Node 25 / Windows and crashing with `UV_HANDLE_CLOSING` assertions.
5. ✅ **M5 — GUI shell.** Electron 41 + React 19 + Vite 8. `packages/gui/electron/main.ts` opens a `BrowserWindow` (loads `http://localhost:5173` in dev with retry-on-connection-refused, `file://` to `dist-renderer/index.html` in prod). `electron/preload.ts` exposes a typed `window.wpsync` API via `contextBridge` (no `nodeIntegration`). `electron/sync-bridge.ts` wires `ipcMain.handle()` calls into a shared `SyncSession`, forwards `SyncEvents` to the renderer over `webContents.send('wpsync:event', ...)`, and persists the last-used `rootDir` in `app.getPath('userData')/wpsync-app.json`. Renderer (`src/`): React 19 with `App.tsx` routing between `Setup` and `Main`, `Setup.tsx` running the URL probe → auth check → init flow, `Main.tsx` rendering counts + Pull/Push + force buttons + an event-driven activity log. **Dual tsconfig**: `tsconfig.json` for Electron (NodeNext, composite, refs to `core`); `tsconfig.renderer.json` (DOM lib, `react-jsx`, `noEmit`, used by Vite and the typecheck script). Root `pnpm build` now does `tsc -b && pnpm --filter @wpsync/gui build:renderer` to cover both.
6. ✅ **M6 — Conflict modal + Settings + packaging.** Core: `ConflictResolution` = `'keep-local' | 'keep-server' | 'skip'`; pull and push accept a `resolutions: Record<string, ConflictResolution>` map. Conflict halt only fires for unresolved slugs. Pull writes only when resolution is `keep-server` (or no conflict, or `forcePull`); push only sends when resolution is `keep-local` (or no conflict, or `forcePush`). `keep-server`/`skip` slugs in pull and `keep-local`/`skip` in push emit `action: 'skip'`. Renderer: `ConflictModal` lists each affected `<type>/<slug>` with three radio choices and a bulk-apply row; the Apply handler runs pull then push with the same resolutions map. `Settings` screen wired in via a gear button in the Main header — covers credential test, password update, "Open config.toml" (uses `shell.openPath`), and folder switch via the existing folder picker. `electron-builder` config in `packages/gui/package.json` covers Windows (NSIS), Mac (DMG), and Linux (AppImage) targets with `asarUnpack` for `keytar` and `@iarna/toml` so their native + dependency resolution survives the asar bundling. `dist`, `dist:win`, `dist:mac`, `dist:linux` scripts.
7. ✅ **M7 — Hardening.** `rest-client.request` now does up to **2 retries with exponential backoff + jitter** (250 ms → 500 ms → 1000 ms, capped at 4 s) on 5xx **and** transient network errors (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `UND_ERR_*`, plus a "fetch failed"/"socket hang up" fallback). 429 responses honor the `Retry-After` header. Writes (POST/DELETE) still get zero retries to avoid duplicate creates. Better error messages: 401 hints "Application Password may be wrong or revoked — `wpsync auth set`"; 403 hints `edit_posts` capability; 404 on `/wp-json/` calls out REST API not enabled / wrong URL; ECONNREFUSED/ENOTFOUND/ETIMEDOUT each get a tailored sentence. Push has a **mtime race guard**: each candidate is re-stat'd just before sending; if mtime changed (editor mid-save) or the file disappeared, that slug is logged and skipped (`action: 'skip'`) so the user can re-run cleanly. CLI dry-run polish: explicit "DRY RUN — no files will be written / nothing will be sent" banner, `[DRY] [i/n] slug: would <action>` per-item lines under `--verbose`, and a per-action breakdown summary (`Would pull N items (created X, updated Y, skipped Z)`). Dry-run smoke at `scripts/smoke-dryrun.mjs` asserts the banner, the verb shift, and zero POST/DELETE traffic during a dry-run push. Pull's `session.pull` already skipped `saveState` under dry-run; push's `last_sync` bump is also gated on `!dryRun`.

**Current status:** v1 feature-complete (M1–M7) **plus** the four PRD §8 integration tests are now wired up and green. 109 unit tests + 4 integration tests pass. `pnpm test:integration` brings up a Dockerised WordPress fixture (mariadb + wordpress:6.7-apache) on `http://localhost:8888`, drives the real `wpsync` binary against it, and verifies: round-trip body integrity, ≥101-item pagination across the per_page=100 boundary, conflict halt with exit 4 and zero writes, and tombstone DELETE without `force=true` (proven by restoring the trashed post). `pnpm --filter @wpsync/gui dist:win` still produces a working `wpsync Setup 0.0.0.exe` on Windows without admin or Developer Mode.

## Common commands

```bash
pnpm install                          # bootstrap workspace
pnpm build                            # tsc -b across composite project refs (root)
pnpm test                             # vitest in every package (root → pnpm -r test)
pnpm lint                             # eslint . from root
pnpm --filter @wpsync/core test       # unit tests, one package
pnpm --filter @wpsync/cli dev -- pull # run the CLI from source via tsx

# End-to-end smoke: mocks WP, drives bin, asserts pull/push round-trip integrity
node scripts/smoke.mjs

# Integration tests (Docker required)
pnpm fixture:up                              # node test/fixtures/wordpress/wp-init.mjs — boots WP, installs, seeds 105 posts
pnpm test:integration                        # builds, runs the four PRD §8 ACs against the live fixture
pnpm fixture:down                            # docker compose down (volumes preserved)
pnpm fixture:reset                           # docker compose down -v — wipe all WP state

# WPSYNC_TEARDOWN=1 pnpm test:integration   # also tears the fixture down after the run (CI mode)

# GUI
pnpm --filter @wpsync/gui dev               # Vite + Electron concurrently with hot-reload
pnpm --filter @wpsync/gui build             # tsc -b + vite build → dist-electron/ + dist-renderer/
pnpm --filter @wpsync/gui start             # run the built Electron app
pnpm --filter @wpsync/gui typecheck:renderer # tsc --noEmit on src/ via tsconfig.renderer.json
pnpm --filter @wpsync/gui dist              # electron-builder for the host platform → packages/gui/release/
pnpm --filter @wpsync/gui dist:win          # NSIS installer; runs the 7za-shim flow on Windows
pnpm --filter @wpsync/gui dist:mac          # DMG (Mac only)
pnpm --filter @wpsync/gui dist:linux        # AppImage
```

**Working-directory gotcha:** The Bash tool's cwd persists across commands. After any `cd` into a sub-package, prefix the next root-level command with `cd C:/repos/wordpress-file-sync &&` or root scripts (`pnpm build`, `pnpm test`) will run inside the sub-package.

## Open risks (flagged before code is written)

1. **Front-matter mutation race.** Push rewrites the file after a successful API call; if an editor has unsaved changes, the next save loses our rewrite. Mitigation: detect `mtime` change between read and write inside `push`, abort that file with a clear error.
2. **`modified_gmt` precision.** WP doesn't bump it for pure taxonomy edits via wp-admin. Mitigation: when pulling, compare `categories`/`tags` arrays too and treat drift as a server change.
3. **`keytar` on Windows.** Credential Manager entries are bound to the Windows user profile; switching users invalidates them silently. Mitigation: always run `auth test` first on `pull`/`push`; on 401 with an existing entry, prompt re-auth.
4. **Electron + workspace TS imports.** `keytar`'s native `.node` won't load from inside `app.asar` — `electron-builder` config needs `asarUnpack: ['**/keytar/**']` and the right `extraResources`.
5. **`Link: rel="next"` stripped by reverse proxies.** Some WP installs sit behind proxies that drop the header. Mitigation: dual-strategy paginator probes once per session.
6. **Slug collisions across types.** WP allows a post and a page sharing a slug. Disk is fine (`posts/` vs `pages/`), but the conflict reporter must always print `<type>/<slug>`.
7. **electron-builder on Windows without Developer Mode — fixed via 7za shim.** The bundled `7zip-bin@5.2.0` ships 7-Zip 21.07, and `app-builder` (the Go binary electron-builder shells out to) calls it with `7za x ...` to extract the `winCodeSign-2.6.0.7z` cache. That archive contains macOS dylib symlinks; creating Windows symlinks requires admin or Developer Mode, so the extract dies with `Cannot create symbolic link : A required privilege is not held by the client`. The `-snld` flag was added in 7-Zip 22.00 but in modern versions it's specifically for *Windows* symlinks and doesn't bypass extraction of POSIX symlinks. The fix: `packages/gui/scripts/dist-win.mjs` compiles a tiny C# shim (`scripts/7za-shim/7za-shim.cs` → `7za.exe` via `csc.exe` from .NET Framework 4 — present on every Windows install since Win 8) that intercepts the `7za x ...` invocation, appends `-xr!darwin` (to skip the entire darwin subtree), and forwards everything else verbatim to the bundled 7za. The shim replaces the bundled `7za.exe` (idempotent — keeps the original as `real-7za.exe`) before electron-builder runs, so `builder-util`'s `SZA_PATH = await getPath7za()` env override picks it up. Adds a 150ms post-extract sleep to let Windows fully release file handles before app-builder renames the temp dir; without it the rename intermittently fails with "Access is denied".

## Style guardrails for this codebase

- No comments unless the *why* is non-obvious (a hidden invariant, a workaround for a specific WP quirk). Don't restate what code already says.
- No backwards-compat shims, deprecation aliases, or "removed:" marker comments — this is greenfield.
- No error handling for impossible cases — trust internal code; validate only at the WP REST boundary and at user input (CLI args, GUI fields).
- Keep `@wpsync/core` free of CLI- or Electron-specific dependencies. The events bus is the interface.
- React renderer imports types from `react`, not the global `JSX` namespace — React 19 dropped the global ambient `JSX` declaration. Use `import type { JSX } from 'react'` when you need the return type explicitly, or just let TS infer.

## User context

The user (Jordi) is the author of the PRD and the intended single user — a developer maintaining a WordPress blog (livablesoftware.com per PRD §3) who prefers local editing tools and Git-tracked content. No collaborative editing requirements. Treat ergonomic decisions through the lens of one author with a text editor and a terminal, not a team.
