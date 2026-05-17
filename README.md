# wpsync

> Incremental, bidirectional sync between a WordPress site and a local directory — so you can edit posts in your favourite text editor and track them in Git.

`wpsync` is a CLI + local web GUI that mirrors WordPress posts and pages as plain `.html` files with YAML front-matter. Content round-trips losslessly: pull → edit locally → push, and the server sees exactly what it would have stored anyway. No theme/plugin/media sync, no real-time webhooks, no three-way merges — just a clean local copy of `wp_posts.post_content` you can grep, diff, and version-control.

**Status:** v1 feature-complete. The GUI is now a local Express + React web app you launch from your terminal — no installer required. See [Installation](#installation) to get started.

---

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart (CLI)](#quickstart-cli)
- [GUI](#gui)
- [On-disk layout](#on-disk-layout)
- [File format](#file-format)
- [Conflict handling](#conflict-handling)
- [Deletions (tombstone model)](#deletions-tombstone-model)
- [Media](#media)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Exit codes](#exit-codes)
- [Development setup](#development-setup)
- [Testing](#testing)
- [Project status](#project-status)
- [Out of scope (v1)](#out-of-scope-v1)
- [Troubleshooting](#troubleshooting)

---

## Why

If you write long-form posts, you probably already have a text editor you love. WordPress's block editor is great, but it's not your editor, and it doesn't live in your Git history. `wpsync` keeps the WordPress server as the canonical publishing surface while letting you author, diff, and back up posts as plain files.

- **Mirror posts as plain files** for local editing, Git tracking, and backup.
- **Incremental sync in both directions**, driven by `modified_gmt` timestamps.
- **Round-trip integrity**: a post pulled and immediately pushed back produces no diff on the server.
- **Downstream-friendly output**: anything that reads text can analyse your content offline. See [`cms-insight`](https://github.com/jcabot/cms-insight) for an example of running analyses over a `wpsync` content tree.
- **Single-user, single-site, scriptable** — designed for one author with a terminal, not a team.

## How it works

- Talks to WordPress via the **REST API v2** (`/wp-json/wp/v2/`) using `context=edit` so it receives raw `post_content`, not rendered HTML.
- Authenticates with **Application Passwords** (built into WP core since 5.6) sent as HTTP Basic Auth over HTTPS.
- Stores the Application Password in `<root>/.wpsync/credentials.json` (file mode `600` on POSIX), gitignored by default. Credentials never appear in `state.json`, log output, or any Git-tracked file.
- Tracks per-post state in YAML front-matter (post ID + last known server `modified_gmt`); tracks site-level state in `.wpsync/state.json` (`last_sync` timestamp).
- Detects conflicts when both sides changed since `last_sync` and halts safely with **zero writes** until you resolve.

## Requirements

- **Node.js** ≥ 20 (CLI and GUI both run on plain Node).
- **pnpm** ≥ 9 (workspace package manager).
- A WordPress site running **WP ≥ 5.6**, reachable over HTTPS, with the REST API enabled.
- A WordPress user with `edit_posts` capability and an **Application Password** (generate at *Users → Profile → Application Passwords* in wp-admin).
- *(Development & integration tests only)* **Docker** with Compose v2.

## Installation

There's no prebuilt installer; both the CLI and the GUI run directly from the cloned repo:

```bash
git clone https://github.com/jcabot/wordpress-file-sync.git
cd wordpress-file-sync
pnpm install
pnpm build
```

For the **CLI**, link it onto your `PATH` once:

```bash
pnpm --filter @wpsync/cli link --global   # exposes `wpsync` globally
# or invoke without linking:
pnpm --filter @wpsync/cli exec wpsync ...
```

For the **GUI**, run the launcher from `packages/gui/`:

- Windows: double-click `packages/gui/start.bat` (or run it from a terminal).
- macOS / Linux: `bash packages/gui/start.sh`.

The launcher runs `pnpm install`, starts the Express backend + Vite dev server, and opens `http://localhost:5173` in your default browser.

## Quickstart (CLI)

```bash
# 1. Scaffold a content directory
wpsync init https://example.com --dir my-blog
cd my-blog
# (or: cd into an existing folder first and run `wpsync init https://example.com`)

# 2. Store your Application Password in .wpsync/credentials.json (mode 600)
wpsync auth set        # prompts for username + app password
wpsync auth test       # GET /wp/v2/users/me — confirms credentials work

# 3. Pull everything (first run is full)
wpsync pull --full

# 4. Edit a post in your favourite editor
$EDITOR posts/my-first-post.html

# 5. Push your changes
wpsync push

# 6. See what would change without writing anything
wpsync status
wpsync pull --dry-run
wpsync push --dry-run
```

Subsequent `wpsync pull` invocations are incremental — only items modified after `last_sync` are fetched.

## GUI

The GUI is a local web app: an Express backend (port `4319` by default, loopback only) plus a Vite-built React frontend served either by Vite in dev (port `5173`) or by Express in production. Launch it from `packages/gui/start.bat` (Windows) or `packages/gui/start.sh` (POSIX), and your browser opens to the right page automatically.

- **First run** opens a Setup wizard that asks for the site URL, root folder (server-side directory picker — no native dialog needed), and Application Password, validates each (`GET /wp-json/`, then `GET /wp/v2/users/me`), and writes `.wpsync/config.toml`, `.wpsync/state.json`, and `.wpsync/credentials.json`.
- **Main view** shows the site URL and folder, counts of pending pulls/pushes/conflicts, last sync timestamp, **Pull** and **Push** buttons with per-item progress, and a recent activity log. Progress events stream over **Server-Sent Events** (`/api/events`) — no polling.
- **Conflict modal** appears when a sync halts on conflicts, listing each slug with *Keep local*, *Keep server*, or *Skip* radio options.
- **Settings** lets you test or update credentials, switch content folders, or open `config.toml` directly for advanced flags.

The Express backend imports `@wpsync/core` directly — there's no subprocess or stdin/stdout IPC between the HTTP layer and the sync logic. The CLI and GUI share exactly the same engine.

### Production mode (single port)

```bash
pnpm --filter @wpsync/gui build       # tsc -b + vite build → dist-server + dist-client
pnpm --filter @wpsync/gui start       # Express on 4319, serves the built bundle + API
```

In production mode the Vite dev server is not running; Express serves the built static client at `/` and the API at `/api/*` on the same port.

### Remote access

The Express server binds to `127.0.0.1` only. This is **deliberate** — the API has no authentication and several endpoints (filesystem listing, opening files in the OS default editor, manipulating WordPress credentials) would be dangerous to expose on the network. Don't change the bind to `0.0.0.0` unless you intend to put a reverse proxy with auth in front of it.

To use the GUI from another machine without exposing it, tunnel the loopback port over SSH:

```bash
# On your laptop, forwards localhost:4319 → vps's 127.0.0.1:4319
ssh -L 4319:127.0.0.1:4319 user@your-vps

# In a browser on your laptop:
open http://localhost:4319
```

Same UX as running locally; no public surface, no auth to maintain.

## On-disk layout

```
my-blog/
├── .wpsync/
│   ├── config.toml         # site URL, content dir, enabled types, username
│   ├── state.json          # last_sync timestamp, schema version
│   ├── taxonomy.json       # cached category/tag ID ↔ slug map
│   └── credentials.json    # stored Application Password; chmod 600 (POSIX)
├── posts/
│   ├── my-first-post.html
│   └── another-post.html
├── pages/
│   ├── about.html
│   └── contact.html
└── .gitignore              # excludes .wpsync/credentials.json by default
```

Commit `.wpsync/config.toml` and `.wpsync/state.json` if you want — neither contains secrets. `credentials.json` is gitignored by default; `wpsync init` writes the `.gitignore` line for you.

## File format

Each post or page lives in one `.html` file with YAML front-matter:

```html
---
id: 1234
type: post
slug: my-first-post
title: My First Post
status: publish
categories: [research, mde]
tags: [besser, low-code]
featured_media: 5678
excerpt: Short summary shown on archive pages.
date_gmt: 2025-01-10T10:00:00
modified_gmt: 2025-04-22T15:30:00
---

<!-- wp:paragraph -->
<p>Raw post_content goes here, exactly as stored in wp_posts.</p>
<!-- /wp:paragraph -->
```

- The body is `content.raw` written **verbatim** — Gutenberg block markers, shortcodes, and HTML are preserved byte-for-byte. No transformation, ever.
- `categories` and `tags` are slugs, resolved against a small local ID↔name cache so files stay readable.
- Pages add a `parent: <id>` field (`0` for top-level) and omit `categories`/`tags`.
- `*_gmt` timestamps are ISO-8601 in GMT (no offset suffix), matching what WordPress emits.

A new post can be created by dropping a file into `posts/` with no `id` field; on push, `wpsync` calls `POST /wp/v2/posts`, then writes the assigned ID back into the front-matter.

## Conflict handling

If a post has been modified on **both** the server and locally since `last_sync`, `wpsync` halts and reports the conflict — **no files or API calls are written**. Resolve by:

- **Editing one side** so it's clearly the canonical version, then re-run.
- **Deleting one side** (the file, or the post in wp-admin), then re-run.
- **Forcing a direction** with `--force-pull` (server wins) or `--force-push` (local wins).
- In the GUI, picking **Keep local** / **Keep server** / **Skip** per slug in the conflict modal.

Conflict detection compares the server's current `modified_gmt` against the value stored in your file's front-matter, and your file's `mtime` against the same value, with a 2-second tolerance. New files (no `id`) and tombstones (`status: trash`) are never in conflict — they reflect explicit local intent.

## Deletions (tombstone model)

To delete a post, set `status: trash` in its front-matter and save. On the next push:

1. `wpsync` calls `DELETE /wp/v2/<type>/<id>` **without** `force=true`.
2. WordPress moves the item to its trash (recoverable for 30 days).
3. The local file is removed.

Plain `rm` of a local file is **not** a deletion — the file will be re-pulled on the next sync. `wpsync` never sends `force=true`; permanent deletion remains a wp-admin-only action.

## Media

`wpsync` does not download or upload media files in v1. Behaviour:

- `featured_media` (the post's featured image ID) lives in front-matter and round-trips like any other metadata field.
- Inline media URLs inside `post_content` are preserved verbatim (consequence of the verbatim-content policy).
- New images must be uploaded via the WordPress admin first, then referenced from a locally edited post.

## Configuration

`.wpsync/config.toml` (created by `wpsync init`):

```toml
site_url     = "https://example.com"
content_dir  = "."
enabled_types = ["post", "page"]
username     = "your-wp-user"
```

`.wpsync/state.json` (managed by the tool — generally don't edit by hand):

```json
{
  "schema_version": 1,
  "last_sync": "2026-04-26T10:23:45"
}
```

`.wpsync/credentials.json` (created by `wpsync init` / `wpsync auth set` and updated by the GUI's setup wizard):

```json
{
  "version": 1,
  "entries": {
    "https://example.com": "<application-password>"
  }
}
```

The file is written with mode `600` on POSIX so only your user can read it. It is gitignored by default. The username comes from `config.toml`; only the password lives here.

The GUI also reads `packages/gui/.env` for installation-wide settings — see `packages/gui/.env.example` for the available variables (`WPSYNC_PORT`, `WPSYNC_DEV`, `WPSYNC_OPEN_BROWSER`).

## CLI reference

```
wpsync init [<site-url>] [--dir <path>]               # scaffold config, prompt for credentials
wpsync pull   [--full] [--type post|page] [--dry-run] [--force-pull]
wpsync push           [--type post|page] [--dry-run] [--force-push]
wpsync status         [--type post|page]
wpsync auth   set | test | clear
```

### Commands

- **`init`** — creates `.wpsync/config.toml` and `.wpsync/state.json`, then runs the auth flow. `--dir <path>` chooses (and creates if needed) the target directory; without it, the current working directory is used. Idempotent; safe to re-run.
- **`pull`** — incremental by default. `--full` re-pulls everything (ignores `last_sync`). `--type` restricts to one type. `--dry-run` lists changes without writing. `--force-pull` overwrites local on conflict.
- **`push`** — symmetric to pull. `--force-push` overwrites server on conflict.
- **`status`** — read-only. Shows pending pulls (server newer), pending pushes (local newer), conflicts, and tombstones queued for deletion.
- **`auth set`** — stores a new Application Password in `.wpsync/credentials.json`.
- **`auth test`** — verifies the stored credentials via `GET /wp/v2/users/me`.
- **`auth clear`** — removes the entry for this site from `credentials.json`.

### Global flags

- `--verbose` / `-v` — print every item event.
- `--quiet` / `-q` — print only errors and final counts.
- `--config <path>` — override the default `.wpsync/config.toml` location.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (or no-op) |
| `1` | Generic error |
| `2` | Usage error |
| `3` | Auth failure (401/403) |
| `4` | Conflict detected — zero writes performed |
| `5` | Network / transport error |

## Development setup

```bash
git clone https://github.com/jcabot/wordpress-file-sync.git
cd wordpress-file-sync
pnpm install

# Build everything (TypeScript project refs + Vite client bundle)
pnpm build

# Run unit tests across all packages
pnpm test

# Run the CLI from source against a real WP
pnpm --filter @wpsync/cli dev -- pull

# Run the GUI in dev mode (Express + Vite with hot-reload)
pnpm --filter @wpsync/gui dev
```

### Workspace layout

```
packages/
├── core/            # @wpsync/core — sync library, no CLI/server deps
├── cli/             # @wpsync/cli  — bin: wpsync (commander)
└── gui/
    ├── server/      # Express backend + SSE hub
    └── client/      # React 18 + Vite frontend
test/
├── fixtures/wordpress/   # docker-compose.yml + wp-init.sh
└── integration/          # cross-package end-to-end tests
```

The core library is the public API; CLI and GUI server are thin shells on top of it. If you're contributing, start by reading `packages/core/src/index.ts`.

### GUI dev mode

```bash
pnpm --filter @wpsync/gui dev          # Express (4319) + Vite (5173) concurrently
pnpm --filter @wpsync/gui dev:server   # backend only
pnpm --filter @wpsync/gui dev:client   # Vite only
pnpm --filter @wpsync/gui build        # tsc -b + vite build → dist-server + dist-client
pnpm --filter @wpsync/gui start        # production: Express serves built bundle + API on one port
pnpm --filter @wpsync/gui typecheck    # tsc --noEmit on both server and client
```

In dev, Vite proxies `/api/*` to Express on `http://127.0.0.1:4319`, so the React code always uses relative URLs. Server-Sent Events stream over `/api/events`.

## Testing

### Unit tests

```bash
pnpm test                             # all packages
pnpm --filter @wpsync/core test       # one package
pnpm --filter @wpsync/core test -- --watch
```

### Integration tests (Docker)

The integration suite spins up a containerised WordPress + MariaDB, provisions an Application Password via `wp-cli`, and seeds 105 posts so the pagination acceptance criterion (≥101 items) is exercised on every run.

```bash
pnpm fixture:up           # boot the fixture and seed it (idempotent)
pnpm test:integration     # build, then run the four PRD §8 integration tests
pnpm fixture:down         # docker compose down (keeps volumes for fast iteration)
pnpm fixture:reset        # docker compose down -v — wipe all WordPress state

# CI mode: `WPSYNC_TEARDOWN=1` tells globalSetup's teardown hook to also bring
# the fixture down after the run.
WPSYNC_TEARDOWN=1 pnpm test:integration
```

The four tests, drive the actual `wpsync` binary as a child process:

- **`pull-pagination.test.ts`** — fresh init + `pull --full --type post`; asserts ≥101 seed files in `posts/`. wpsync paginates **one item per REST request** (`per_page=1`) so a single bad post can't poison the whole pull, so this exercises ≥101 successful page fetches in sequence.
- **`pull-roundtrip.test.ts`** — pull → edit a unique marker into a seed post's body → push → full-pull; asserts the body bytes after push equal the body bytes after re-pull.
- **`conflict-halt.test.ts`** — pull a seed post, locally edit + bump mtime, mutate the same post server-side via `wp-cli`; asserts both `wpsync pull` and `wpsync push` exit 4, the local file is untouched, and the server's title is unchanged.
- **`tombstone-no-force.test.ts`** — create a fresh post on the server, pull it, set `status: trash` locally, push; asserts the local file is gone, the server post is in `trash` status (not purged), and `wp post update --post_status=draft` successfully restores it — proving `force=true` was never sent.

CI runs the Docker integration suite on `ubuntu-latest` only (Docker on Windows runners is flaky); unit tests run on Ubuntu, Windows, and macOS.

> **Note for non-SSL local fixtures:** WP 6.x disables Application Passwords on plain HTTP unless the site is marked as a local environment. `docker-compose.yml` sets `WP_ENVIRONMENT_TYPE=local` for that reason. `wp-init.mjs` also patches Apache's default `AllowOverride None` so WordPress's `.htaccess` `Authorization`-header rewrite actually fires.

## Project status

`wpsync` v1 is **feature-complete and end-to-end-tested**. 130 unit tests + 4 integration tests pass on every run. The PRD §8 acceptance criteria — round-trip body integrity, ≥101-item pagination, conflict halt with exit 4 and zero writes, and tombstone DELETE without `force=true` — are all verified against a real Dockerised WordPress instance.

| Milestone | Scope | State |
|-----------|-------|-------|
| **M1** | Skeleton: pnpm workspace, three packages, tsconfig refs, vitest, lint, CI | ✅ done |
| **M2** | Read-only pull (CLI `init` + `auth set/test/clear` + `pull --full --type --dry-run`) | ✅ done |
| **M3** | Push with write-back and `mtime` adjustment; round-trip integrity verified end-to-end | ✅ done |
| **M4** | Conflict detection (exit 4, zero writes), tombstone deletion (DELETE without `force=true`), `wpsync status`, `--force-pull` / `--force-push` | ✅ done |
| **M5** | GUI shell — Express backend + React 18 frontend (Vite), Setup wizard with server-side folder picker, Main view with SSE-driven progress | ✅ done |
| **M6** | Per-slug ConflictModal, Settings screen (test creds, change password, switch folder, open config), production single-port deployment | ✅ done |
| **M7** | Hardening: exponential-backoff retries with transient-network-error retry, Retry-After on 429, friendly 401/403/404/ECONNREFUSED/etc messages, push mtime race guard + per-item `getItem` re-check, dry-run output polish | ✅ done |
| **M8** | Hostile-WP resilience: `per_page=1` listings, per-item skip on malformed responses (cache/CDN/security plugin returning HTML with JSON content-type), explicit `User-Agent`, `status=any` removed from listing params | ✅ done |
| **Integration** | Dockerised WP fixture + 4 PRD §8 ACs (round-trip, ≥101-item pagination, conflict halt, no-force tombstone) | ✅ done |

End-to-end smokes (mocked WP server, drives the actual `wpsync` binary):

```bash
node scripts/smoke.mjs          # init, pull, push, conflict halt, force-pull, tombstone
node scripts/smoke-dryrun.mjs   # DRY RUN banner, breakdown summary, zero side-effect guarantee
```

## Out of scope (v1)

- Theme, plugin, or media library sync.
- Real-time / webhook-driven sync (manual or cron-scheduled only).
- Multi-user collaborative editing or three-way merge.
- Custom post types beyond `post` and `page`.
- Multi-site, comments, users.

## Troubleshooting

**`401 Unauthorized` when running `wpsync auth test`.** Confirm the Application Password is correct (no spaces — wp-admin shows it with spaces for readability, but they're optional), the user has `edit_posts`, and the site is reachable over HTTPS.

**`wpsync pull` writes nothing even though I edited a post in wp-admin.** WordPress only updates `modified_gmt` when `post_content` or specific meta fields change; pure taxonomy edits via wp-admin can leave it unchanged. Pulling will catch the drift on the next content edit, or run `wpsync pull --full` to force a full re-pull.

**Pagination seems wrong.** Some WP installs sit behind reverse proxies that strip the `Link` response header. `wpsync` falls back to `X-WP-TotalPages` automatically; run with `--verbose` to see which path it took.

**Conflict on a post I haven't touched locally.** Saving a file in your editor updates its `mtime` even if the bytes didn't change. Either re-pull with `--force-pull` to resync, or only save files when you actually edit them.

**`Skipped malformed WordPress REST page X` warnings during pull.** Your WordPress install is intermittently returning the public homepage HTML in place of REST API JSON for specific posts — typically a cache plugin (W3 Total Cache, WP Rocket, LiteSpeed Cache) or security plugin (WordFence, Sucuri) or CDN page rule (Cloudflare) is intercepting a subset of `/wp-json/...` URLs based on something content-specific (a shortcode, a particular block, an image embed). wpsync detects the lying response, skips that one post, and keeps going — those items will be retried on the next pull. To eliminate the skips: identify the affected post slugs in the activity log, open them in wp-admin, and look for the rule trigger (often a Divi/Elementor template, a security-plugin "block by content pattern" rule, or a stale CDN cache entry that needs purging for that specific URL). Adding `/wp-json/*` to the cache plugin's exclusion list and purging the cache fixes most cases.

**GUI: "EADDRINUSE" on port 4319 or 5173.** Another process is already bound to the port. Either close it or set `WPSYNC_PORT` in `packages/gui/.env` to a different number (the Vite dev server reads the same variable to wire its proxy correctly).

**GUI: browser opens but `/api/...` calls return CORS errors.** You're probably running the Vite dev server without the Express backend. Start both with `pnpm --filter @wpsync/gui dev`, not `dev:client` alone.
