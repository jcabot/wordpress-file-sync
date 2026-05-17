# CLAUDE.md — `wpsync`

Engineering context for Claude sessions working on this repo. User-facing docs live in `README.md`.

## What this project is

`wpsync` — a CLI + local web GUI that performs **incremental, bidirectional sync** between a WordPress site and a local directory via the WP REST API. Posts are stored on disk as raw `post_content` (Gutenberg block markup, shortcodes, HTML — verbatim, no transformation) wrapped in YAML front-matter, so they're editable in any text editor and Git-trackable.

Single-user, single-site, scriptable. Greenfield TypeScript codebase.

## Source-of-truth documents

- **PRD:** `C:\Users\jordi.cabot\Downloads\prd-wp-local-sync (3).md` — authoritative for endpoints, file format, CLI surface, GUI states, exit codes, conflict semantics, tombstone deletions, decision log. Read before making design decisions.
- **Original implementation plan:** `C:\Users\jordi.cabot\.claude\plans\indexed-launching-dragonfly.md` — covers M1–M7 of the original Electron build (approved 2026-04-26).
- **GUI rewrite plan:** `C:\Users\jordi.cabot\.claude\plans\wild-coalescing-fountain.md` — covers the migration from Electron to Express+browser and the credentials simplification (approved and shipped 2026-05-02).

## Confirmed scope decisions (do not re-litigate)

- Ship **CLI and local web GUI together** in v1 — not phased.
- **pnpm workspaces** monorepo (not Turborepo, not single package).
- Integration tests run against a **Docker Compose WordPress + MariaDB** fixture.
- **TypeScript** across all packages; **commander** for CLI; **Express** backend + **React 18 + Vite** frontend for the GUI; **vitest** as the only test runner.
- Credentials live in **`<root>/.wpsync/credentials.json`** as plain JSON, file mode `600` on POSIX. No keychain, no encryption — gitignored by default.

## Workspace layout

```
packages/
├── core/            # @wpsync/core — sync library (no CLI/server deps)
├── cli/             # @wpsync/cli  — bin: wpsync (commander)
└── gui/
    ├── server/      # Express backend + SSE hub (Node 20+)
    └── client/      # React 18 frontend (Vite)
test/
├── fixtures/wordpress/   # docker-compose.yml + wp-init.sh seeding 105 posts
└── integration/          # cross-package end-to-end tests
```

Composite TS project references (`tsconfig.base.json`) so the GUI server imports `@wpsync/core` as **TypeScript source**, not a built artefact. The client has its own `tsconfig.json` (DOM lib, `noEmit`) used by Vite + the typecheck script.

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

CLI and GUI both subscribe to `session.events`. CLI pipes them to stdout (verbose/quiet renderers); the Express backend forwards them to a single persistent SSE stream at `GET /api/events`, which the React client subscribes to via `EventSource` on mount.

## Module map (`packages/core/src/`)

| File | Responsibility |
|---|---|
| `rest-client.ts` | `fetch` wrapper, Basic Auth, **always `context=edit`**, real `User-Agent: wpsync/1.0` so security plugins don't flag it. **Listings use `per_page=1` (one item per REST page)** so a single bad post can't poison the whole pull. `Link: rel="next"` paginator with fallback to `X-WP-TotalPages` + `?page=N`, retry-with-backoff on 5xx and transient network errors, `AuthError`/`TransportError` mapping. On a 404 (or non-JSON response) to `/wp-json/...`, transparently retries via `?rest_route=/wp/v2/...` and locks the mode for the session. Detects "Content-Type lies (claims JSON, body is HTML)" responses and throws `TransportError(404)` so the rewrite-fallback fires; if that also fails, the page is treated as **skip-able**, not fatal — see `paginatedGet` |
| `frontmatter.ts` | `encode`/`decode` via `yaml` package |
| `paths.ts` | slug→filename, type→subdir, `.wpsync/*` resolution |
| `state.ts` | Atomic temp+rename writes for `.wpsync/state.json` and `.wpsync/config.toml` (`@iarna/toml`) |
| `taxonomy-cache.ts` | Lazy-load categories/tags, persist to `.wpsync/taxonomy.json` |
| `mapper.ts` | `restItemToFrontmatter` and inverse; ID↔slug taxonomy resolution |
| `pull.ts` | `modified_after` query, paginate one item at a time, surface per-page progress via `onPage` callback (emitted as `log` events), write files, advance `last_sync` to **max** observed `modified_gmt`. **Skipped pages** (server returned HTML/non-JSON for that specific item) emit `level: 'warn'` log entries and don't break the run |
| `push.ts` | Walk dir, decode, compare `mtime` vs front-matter `modified_gmt`, fetch fresh `getItem(id)` per candidate just before send (race guard), POST/create, write back |
| `conflict.ts` | Pure detector; runs **before any writes** |
| `tombstone.ts` | `status: trash` → `DELETE /wp/v2/<type>/<id>` **without `force`** (PRD §4.5, §8 AC) |
| `events.ts` | Strongly-typed `EventEmitter<SyncEvents>` |
| `errors.ts` | `AuthError`, `ConflictError(slugs)`, `TransportError`, `UsageError` |
| `credentials.ts` | Simple file-backed store at `<root>/.wpsync/credentials.json` with mode `600` on POSIX. Plain JSON, no encryption |

## GUI module map (`packages/gui/`)

| File | Responsibility |
|---|---|
| `server/src/main.ts` | Bootstrap: load `.env` via `dotenv`, build app, `listen(127.0.0.1, PORT)`, optionally `open()` the browser in production |
| `server/src/app.ts` | Express app factory; mounts `/api/*` routes; in production, also serves `dist-client/` static at `/`; in dev, leaves `/` to Vite |
| `server/src/session.ts` | Owns one `SyncSession` per server lifetime; recreated on `init`/`adopt`. Forwards all `SyncEvents` to the SSE hub |
| `server/src/sse.ts` | `SseHub` — single broadcaster; `GET /api/events` attaches a client, hub.broadcast writes `event:` + `data:` to every connected response |
| `server/src/state.ts` | Last-used `rootDir` persisted at `~/.wpsync/app-state.json` (replaces Electron `userData`) |
| `server/src/error-mapping.ts` | `AuthError`→401, `ConflictError`→409 + slugs, `TransportError`→502, `UsageError`→400, default→500. Mirrors CLI exit-code mapping |
| `server/src/routes/config.ts` | `GET /api/state/last-root`, `GET /api/config?root=<path>` |
| `server/src/routes/fs.ts` | `GET /api/fs/list?path=<abs>` (server-side directory picker; dirs only, dotfiles hidden), `GET /api/fs/home` |
| `server/src/routes/probe.ts` | `POST /api/probe-url`, `POST /api/auth/test` |
| `server/src/routes/init.ts` | `POST /api/init`, `POST /api/adopt` (writes `.wpsync/{config.toml,state.json,credentials.json}` + `.gitignore`) |
| `server/src/routes/status.ts` | `GET /api/status` |
| `server/src/routes/sync.ts` | `POST /api/pull`, `POST /api/push` — runs synchronously, response is the final `{ ok, written, skipped }` (or `{ ok:false, code, message, slugs? }`); progress events stream over the persistent SSE channel |
| `server/src/routes/shell.ts` | `POST /api/config/open` — opens `config.toml` in the OS default editor via `open` npm package |
| `client/src/lib/api.ts` | `fetch`-based client + `EventSource('/api/events')`. Exposes the same surface (`api.pull(...)`, `api.push(...)`, `api.onEvent(cb)`) the React screens already used in the Electron version |
| `client/src/components/FolderPicker.tsx` | Directory-picker modal; calls `api.fsList(path)` to navigate, "Select this folder" returns absolute path |
| `client/src/screens/{Setup,Main,Settings}.tsx` | Same React 18 components from before; only the folder-picker integration differs |

## Critical conventions and invariants

These are not negotiable — they come from the PRD and breaking them violates acceptance criteria:

1. **Verbatim `post_content`.** Body is `content.raw` written byte-for-byte; never transform, normalise whitespace, or re-render. Round-trip integrity AC depends on this (PRD §4.1, §8).
2. **`context=edit` always** on posts/pages REST queries (PRD §6) — without it the API returns `content.rendered`, breaking round-trip.
3. **DELETE never sends `force=true`.** Trashes only; permanent deletion is a wp-admin-only action. Verifiable by HTTP capture (PRD §4.5, §8 AC).
4. **Plain `rm` is not a deletion.** A removed file is re-pulled on next sync. Tombstone deletion = set `status: trash` in front-matter and push.
5. **Credentials never leave `<root>/.wpsync/credentials.json`.** No password in `state.json`, `config.toml`, log output, or any Git-tracked file (PRD §8 AC). The `.gitignore` written by `init` excludes `credentials.json`.
6. **Conflict halt = zero writes.** When both sides have changed since `last_sync`, exit code 4, name affected slugs, no file or API writes happen.
7. **Always print `<type>/<slug>`** in conflict reports — slugs can collide across `posts/` and `pages/`.
8. **GUI server binds to `127.0.0.1` only.** Never `0.0.0.0`. Single-user local app.

## Hostile-WP resilience (per-item listing)

Real WordPress installs sit behind cache plugins, CDNs, and security plugins that intermittently corrupt REST responses for specific URLs/posts — most often serving the public homepage HTML with `Content-Type: application/json`. The listing is engineered to survive these:

- **Listings paginate at `per_page=1`** (`ITEM_PER_PAGE` in `rest-client.ts`). Each REST request fetches a single post or page. A bad response affects exactly one item rather than 100.
- **`request()` validates the body parses as JSON** even when the `Content-Type` header claims JSON. A lying header throws `TransportError(404)` so the existing rewrite-fallback (`?rest_route=`) fires.
- **`paginatedGet()` skips pages that throw `malformedRestPage` errors** *after* `totalPages` is known (i.e., page 2 onwards). Each skip emits `onPage({ skipped: true })` which `pull.ts` translates into a `log` event ("Skipped malformed WordPress REST page X"). Page 1 still bails fast — without a known total there's no way to safely advance.
- **The `User-Agent` header is set to `wpsync/1.0 (+https://github.com/jcabot/wordpress-file-sync)`** — Node's default UA gets flagged by some security plugins as an unknown scraper.
- **`status=any` is NOT included in listing params** — it was implicated in triggering the bad path on at least one production site (livablesoftware.com). The default `context=edit` returns publish + draft + pending + private + future already, which is what we want.
- **Skipped items are not fatal**, not counted toward `written`, and don't break the conflict pre-pass. A subsequent pull will re-attempt them. The user can identify problem posts in the activity log and fix them at the source (usually a specific block of content or shortcode that triggers the cache/security rule).

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

- `<root>/.wpsync/credentials.json`: `{ version: 1, entries: { [siteUrl]: password } }`. Plain JSON, mode `600` on POSIX (best-effort on Windows). The `init` flow appends `.wpsync/credentials.json` to the project's `.gitignore`.
- `.wpsync/config.toml`: site URL, content dir, enabled types, **username** (Git-safe).
- `.wpsync/state.json`: `last_sync`, schema version. Never credentials.
- The GUI's per-installation settings live in `packages/gui/.env` (`WPSYNC_PORT`, `WPSYNC_DEV`, `WPSYNC_OPEN_BROWSER`); see `.env.example`.

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

Mapped in the CLI's top-level catch in `packages/cli/src/bin.ts` and mirrored in `packages/gui/server/src/error-mapping.ts` (with HTTP status codes 400/401/409/502/500).

## Test strategy

- **Unit:** `packages/*/src/**/*.test.ts` with mocked `fetch`. Cover front-matter round-trip, mapper ID↔slug, conflict matrix (4 cases × force flags), Link-header pagination parser, exit-code mapping. Plus `packages/gui/server/src/error-mapping.test.ts` (Express-side mapping) and `routes/fs.test.ts` (directory listing + path validation).
- **Integration:** `test/integration/src/*.test.ts` — runs as a separate workspace package (`@wpsync/test-integration`) so it doesn't get pulled into `pnpm test`. `vitest globalSetup` calls `setupFixture()` from `test/fixtures/wordpress/wp-init.mjs` which: brings up `db` + `wp` via `docker compose`, polls `/wp-login.php` until reachable, runs `wp core install` (admin user `alice`, password `secret`), enables pretty permalinks, **patches `AllowOverride None` → `All` in the container's `apache2.conf`** so WP's `.htaccess` `Authorization`-header rewrite takes effect, generates an Application Password into `test/fixtures/wordpress/app-password.txt`, and seeds 105 posts with deterministic slugs (`wpsync-seed-001` … `wpsync-seed-105`). Tests drive the **real** `packages/cli/dist/bin.js` as a child process. Vitest is configured single-fork, sequential — the fixture is shared. Four ACs:
  - `pull-roundtrip.test.ts` — pull a seed post, edit body, push, full-pull again, assert post-push body == post-pull body
  - `pull-pagination.test.ts` — fresh init + `pull --full --type post`, assert ≥101 seed files in `posts/` (with `per_page=1`, this requires ≥101 successful page fetches; was originally a per_page=100-boundary test, now exercises the per-item paginator)
  - `conflict-halt.test.ts` — pull a seed post, edit local + bump mtime, mutate server-side via `wp-cli`, assert `pull` and `push` both exit 4, the local file is untouched, and the server's title hasn't changed
  - `tombstone-no-force.test.ts` — create a fresh `wpsync-tomb-<uuid>` server-side, pull, set `status: trash` locally, push, assert local file gone + server post in `trash` status, then `wp post update --post_status=draft` succeeds (proving the row wasn't `force`-deleted)
- **End-to-end smokes** (mocked WP server, drive the actual CLI binary): `node scripts/smoke.mjs` (init, pull, push, conflict halt, force-pull, tombstone) and `node scripts/smoke-dryrun.mjs` (DRY RUN banner, breakdown summary, zero side-effect guarantee).
- **CI:** Docker integration runs on `ubuntu-latest` only (Windows runners are flaky for Docker); unit tests on `{ubuntu, windows, macos}` matrix.

## Implementation milestones

1. ✅ **M1 — Skeleton.** pnpm workspace, three packages, tsconfig refs, vitest, lint, CI green.
2. ✅ **M2 — Read-only pull.** Core: errors, events, types, paths, frontmatter, state, credentials, rest-client, taxonomy-cache, mapper, pull, session. CLI: `commander`-driven bin with `init` / `auth set|test|clear` / `pull --full --type --dry-run`.
3. ✅ **M3 — Push.** `rest-client.createItem`/`updateItem`, `taxonomy-cache.idBySlug`, `mapper.frontmatterToPayload`, `push.ts` (walks `posts/`+`pages/`, classifies create/update/skip with 2-second mtime tolerance, writes back front-matter, `fs.utimes` mtime to server `modified_gmt`), CLI `push --type --dry-run`. End-to-end smoke at `scripts/smoke.mjs` covers idle push no-op, edit-and-push, re-push no-op, and pull→push→pull byte-identity.
4. ✅ **M4 — Conflict + tombstone + status.** `conflict.ts`, `rest-client.deleteItem`, tombstone branch in `push.ts`, conflict pre-pass in `pull.ts` and `push.ts`, `status.ts`, CLI `status` command + `--force-pull` / `--force-push`. **bin.ts uses `process.exitCode` instead of `process.exit()`** to avoid `UV_HANDLE_CLOSING` races on Node 25 / Windows.
5. ✅ **M5 — GUI shell.** Express 4 + React 18 + Vite 6. `packages/gui/server/src/main.ts` boots an Express app on `127.0.0.1:4319` (configurable via `WPSYNC_PORT`); `app.ts` mounts `/api/*` routes and a single SSE stream at `/api/events`; `session.ts` owns one `SyncSession` per server lifetime and forwards events to the SSE hub. `state.ts` persists last-used `rootDir` to `~/.wpsync/app-state.json`. Renderer (`client/src/`): React 18 with `App.tsx` routing between `Setup` and `Main`, `Setup.tsx` running URL-probe → auth-test → init flow with a server-side `FolderPicker` modal (no native dialog), `Main.tsx` rendering counts + Pull/Push + force buttons + an event-driven activity log (subscribes to `EventSource('/api/events')`). Vite proxies `/api/*` → `http://127.0.0.1:4319` in dev so the client uses relative URLs everywhere.
6. ✅ **M6 — Conflict modal + Settings + production deployment.** Core: `ConflictResolution` = `'keep-local' | 'keep-server' | 'skip'`; pull and push accept a `resolutions: Record<string, ConflictResolution>` map. Conflict halt only fires for unresolved slugs. Renderer: `ConflictModal` lists each affected `<type>/<slug>` with three radio choices; the Apply handler runs pull then push with the same resolutions map. `Settings` screen wired in via a gear button — covers credential test, password update, "Open `config.toml`" (`POST /api/config/open` → `open` npm package), and folder switch via the same `FolderPicker` modal. Production: `pnpm --filter @wpsync/gui build` does `tsc -b server/tsconfig.json && vite build --config client/vite.config.ts`; `pnpm --filter @wpsync/gui start` runs `node dist-server/main.js` which serves the built client at `/` and the API at `/api/*` on the same port.
7. ✅ **M7 — Hardening.** `rest-client.request` does up to **2 retries with exponential backoff + jitter** (250 ms → 500 ms → 1000 ms, capped at 4 s) on 5xx **and** transient network errors (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `UND_ERR_*`, plus a "fetch failed"/"socket hang up" fallback). 429 responses honor the `Retry-After` header. `createItem` is the only write that gets `retry: false` (POSTing to the collection endpoint is non-idempotent — retry could create duplicates); `updateItem` (POST `/posts/{id}`) and `deleteItem` (DELETE `/posts/{id}`) are idempotent and retry like reads. Better error messages: 401 hints "Application Password may be wrong or revoked — `wpsync auth set`"; 403 hints `edit_posts` capability; 404 on `/wp-json/` calls out REST API not enabled / wrong URL; ECONNREFUSED/ENOTFOUND/ETIMEDOUT each get a tailored sentence. Push has a **mtime race guard**: each candidate is re-stat'd just before sending; if mtime changed (editor mid-save) or the file disappeared, that slug is logged and skipped. Push also calls `getItem(id)` per candidate to get a fresh server-side `modified_gmt` right before sending, catching server-side edits that happened between the listing and the write. CLI dry-run polish: explicit "DRY RUN — no files will be written / nothing will be sent" banner, `[DRY] [i/n] slug: would <action>` per-item lines under `--verbose`, and a per-action breakdown summary. Dry-run smoke at `scripts/smoke-dryrun.mjs` asserts the banner, the verb shift, and zero POST/DELETE traffic during a dry-run push.

8. ✅ **M8 — Hostile-WP resilience.** Listing switched to `per_page=1` so a single bad post can't poison the whole pull. New `malformedRestPage(err)` detector in `rest-client.ts` distinguishes "Content-Type lies" responses from real failures. `paginatedGet` skips bad pages once `totalPages` is known, emitting `onPage({ skipped: true })` callbacks that surface as `log warn` events. `User-Agent: wpsync/1.0 (+...)` set explicitly. `status=any` removed from listing params (was triggering bad-route paths on real WP installs). New `countItems(type, opts)` and `getItem(type, id)` methods on `RestClient`. All test stubs updated to provide `getItem`.

**Current status:** v1 feature-complete (M1–M8) **plus** the four PRD §8 integration tests are wired up and green. **130 unit tests** (116 core + 3 CLI + 11 GUI server) + 4 integration tests pass. `pnpm test:integration` brings up a Dockerised WordPress fixture (mariadb + wordpress:6.7-apache) on `http://localhost:8888`, drives the real `wpsync` binary against it, and verifies: round-trip body integrity, ≥101-item pagination (now exercising the per-item paginator), conflict halt with exit 4 and zero writes, and tombstone DELETE without `force=true` (proven by restoring the trashed post). `pnpm --filter @wpsync/gui dev` boots the Express server + Vite dev server with hot-reload; `start.bat` / `start.sh` wrap that flow with auto-install + browser-open.

## Common commands

```bash
pnpm install                          # bootstrap workspace
pnpm build                            # tsc -b across composite project refs + vite build
pnpm test                             # vitest in every package (root → pnpm -r test)
pnpm lint                             # eslint . from root
pnpm --filter @wpsync/core test       # unit tests, one package
pnpm --filter @wpsync/cli dev -- pull # run the CLI from source via tsx

# End-to-end smokes (mock WP, drive the real bin)
node scripts/smoke.mjs
node scripts/smoke-dryrun.mjs

# Integration tests (Docker required)
pnpm fixture:up                              # node test/fixtures/wordpress/wp-init.mjs — boots WP, installs, seeds 105 posts
pnpm test:integration                        # builds, runs the four PRD §8 ACs against the live fixture
pnpm fixture:down                            # docker compose down (volumes preserved)
pnpm fixture:reset                           # docker compose down -v — wipe all WP state

# WPSYNC_TEARDOWN=1 pnpm test:integration   # also tears the fixture down after the run (CI mode)

# GUI
pnpm --filter @wpsync/gui dev               # Express (4319) + Vite (5173) concurrently with hot-reload
pnpm --filter @wpsync/gui dev:server        # backend only
pnpm --filter @wpsync/gui dev:client        # Vite only
pnpm --filter @wpsync/gui build             # tsc -b + vite build → dist-server/ + dist-client/
pnpm --filter @wpsync/gui start             # production: node dist-server/main.js (single port serves built client + API)
pnpm --filter @wpsync/gui typecheck         # tsc --noEmit for both server and client
```

The user-facing launchers are at `packages/gui/start.bat` (Windows) and `packages/gui/start.sh` (POSIX). They `pnpm install`, set `WPSYNC_DEV=1`, and run `pnpm --filter @wpsync/gui dev` while opening the browser to `http://localhost:5173`.

**Working-directory gotcha:** The Bash tool's cwd persists across commands. After any `cd` into a sub-package, prefix the next root-level command with `cd C:/repos/wordpress-file-sync &&` or root scripts (`pnpm build`, `pnpm test`) will run inside the sub-package.

## Open risks (flagged before code is written)

1. **Front-matter mutation race.** Push rewrites the file after a successful API call; if an editor has unsaved changes, the next save loses our rewrite. Mitigation: `push.ts`'s mtime race guard (re-stat just before send; skip if mtime moved).
2. **`modified_gmt` precision.** WP doesn't bump it for pure taxonomy edits via wp-admin. Mitigation: when pulling, compare `categories`/`tags` arrays too and treat drift as a server change.
3. **`Link: rel="next"` stripped by reverse proxies.** Some WP installs sit behind proxies that drop the header. Mitigation: dual-strategy paginator probes once per session.
4. **Slug collisions across types.** WP allows a post and a page sharing a slug. Disk is fine (`posts/` vs `pages/`), but the conflict reporter must always print `<type>/<slug>`.
5. **Port collision on 4319 / 5173.** Two simultaneous wpsync instances would fight for ports. Mitigation: server uses `strictPort` so the second instance fails fast with a clear error; user sets `WPSYNC_PORT` in `.env` if they need a different number.
6. **SSE reconnect on transient network blips.** `EventSource` reconnects automatically but doesn't replay missed events. For long pull/push runs, the activity log can drop a few items. Mitigation accepted: the final `done` event carries authoritative counts; the per-item log is best-effort UI feedback only.

## Style guardrails for this codebase

- No comments unless the *why* is non-obvious (a hidden invariant, a workaround for a specific WP quirk). Don't restate what code already says.
- No backwards-compat shims, deprecation aliases, or "removed:" marker comments — this is greenfield.
- No error handling for impossible cases — trust internal code; validate only at the WP REST boundary, the Express request boundary, and at user input (CLI args, GUI fields).
- Keep `@wpsync/core` free of CLI- or server-specific dependencies. The events bus is the interface.
- React renderer uses **React 18** types; import from `react` (no global ambient `JSX` namespace). Vite + Bundler module resolution; no `react-jsx-runtime` ceremony.
- Express routes follow the same pattern: validate inputs at the top, call into core, map errors via `mapError(err)`, return `{ ok: false, code, message, slugs? }` on failure or domain-specific shape on success. Never let a stack trace leak to the client.
- The persistent SSE hub is shared state. Don't try to scope it per-request; the design assumes a single browser tab is the consumer.

## User context

The user (Jordi) is the author of the PRD and the intended single user — a developer maintaining a WordPress blog (livablesoftware.com per PRD §3) who prefers local editing tools and Git-tracked content. No collaborative editing requirements. Treat ergonomic decisions through the lens of one author with a text editor and a terminal, not a team.
