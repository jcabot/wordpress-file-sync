# wpsync

> Incremental, bidirectional sync between a WordPress site and a local directory — so you can edit posts in your favourite text editor and track them in Git.

`wpsync` is a CLI + desktop GUI that mirrors WordPress posts and pages as plain `.html` files with YAML front-matter. Content round-trips losslessly: pull → edit locally → push, and the server sees exactly what it would have stored anyway. No theme/plugin/media sync, no real-time webhooks, no three-way merges — just a clean local copy of `wp_posts.post_content` you can grep, diff, and version-control.

**Status:** v1 in development. See [Project status](#project-status) for the current milestone.

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
- **Single-user, single-site, scriptable** — designed for one author with a terminal, not a team.

## How it works

- Talks to WordPress via the **REST API v2** (`/wp-json/wp/v2/`) using `context=edit` so it receives raw `post_content`, not rendered HTML.
- Authenticates with **Application Passwords** (built into WP core since 5.6) sent as HTTP Basic Auth over HTTPS.
- Stores credentials in the **OS keychain** (macOS Keychain / libsecret / Windows Credential Manager) via `keytar`, with an encrypted file fallback. Credentials never appear in `state.json`, log output, or anything Git-tracked.
- Tracks per-post state in YAML front-matter (post ID + last known server `modified_gmt`); tracks site-level state in `.wpsync/state.json` (`last_sync` timestamp).
- Detects conflicts when both sides changed since `last_sync` and halts safely with **zero writes** until you resolve.

## Requirements

- **Node.js** ≥ 20 (for the CLI and to run the GUI from source).
- **pnpm** ≥ 9 (workspace package manager).
- A WordPress site running **WP ≥ 5.6**, reachable over HTTPS, with the REST API enabled.
- A WordPress user with `edit_posts` capability and an **Application Password** (generate at *Users → Profile → Application Passwords* in wp-admin).
- *(Development & integration tests only)* **Docker** with Compose v2.

## Installation

### From source (current — until v1 ships)

```bash
git clone https://github.com/<your-fork>/wordpress-file-sync.git
cd wordpress-file-sync
pnpm install
pnpm -r build

# Make the CLI runnable on your PATH
pnpm --filter @wpsync/cli link --global
# or invoke directly without linking:
#   pnpm --filter @wpsync/cli exec wpsync ...

# Run the GUI in dev mode
pnpm --filter @wpsync/gui dev
```

### From a release (planned)

Once v1 ships:

- **CLI:** `npm install -g @wpsync/cli` (or grab a single-binary release from the Releases page).
- **GUI:** download the installer for Windows / macOS / Linux from the Releases page.

## Quickstart (CLI)

```bash
# 1. Scaffold a content directory
mkdir my-blog && cd my-blog
wpsync init https://example.com

# 2. Store your Application Password in the OS keychain
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

For the same flow without the terminal, launch the desktop app:

- **First run** opens a Setup wizard that asks for the site URL, root folder, and Application Password, validates each (`GET /wp-json/`, then `GET /wp/v2/users/me`), then runs an initial `pull --full` with progress.
- **Main view** shows the site URL and folder, counts of pending pulls/pushes/conflicts, last sync timestamp, **Pull** and **Push** buttons with per-item progress, and a recent activity log.
- **Conflict modal** appears when a sync halts on conflicts, listing each slug with *Keep local*, *Keep server*, or *Skip* radio options.
- **Settings** lets you test or update credentials, reconfigure site URL/folder, or open `config.toml` directly for advanced flags.

The GUI imports the same sync library the CLI uses — there's no subprocess in between, so progress events stream in real time.

## On-disk layout

```
my-blog/
├── .wpsync/
│   ├── config.toml         # site URL, content dir, enabled types, username
│   ├── state.json          # last_sync timestamp, schema version
│   ├── taxonomy.json       # cached category/tag ID ↔ slug map
│   └── secrets.json        # ONLY when OS keychain is unavailable; chmod 600
├── posts/
│   ├── my-first-post.html
│   └── another-post.html
├── pages/
│   ├── about.html
│   └── contact.html
└── .gitignore              # excludes .wpsync/secrets.json by default
```

Commit `.wpsync/config.toml` and `.wpsync/state.json` if you want — neither contains secrets. `secrets.json` is gitignored by default.

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

Credentials live in your OS keychain under service `wpsync`, account `<site-url>`. The keychain entry holds only the Application Password — the username comes from `config.toml`.

## CLI reference

```
wpsync init [<site-url>]                              # scaffold config, prompt for credentials
wpsync pull   [--full] [--type post|page] [--dry-run] [--force-pull]
wpsync push           [--type post|page] [--dry-run] [--force-push]
wpsync status         [--type post|page]
wpsync auth   set | test | clear
```

### Commands

- **`init`** — creates `.wpsync/config.toml` and `.wpsync/state.json`, then runs the auth flow. Idempotent; safe to re-run.
- **`pull`** — incremental by default. `--full` re-pulls everything (ignores `last_sync`). `--type` restricts to one type. `--dry-run` lists changes without writing. `--force-pull` overwrites local on conflict.
- **`push`** — symmetric to pull. `--force-push` overwrites server on conflict.
- **`status`** — read-only. Shows pending pulls (server newer), pending pushes (local newer), conflicts, and tombstones queued for deletion.
- **`auth set`** — stores a new Application Password in the OS keychain.
- **`auth test`** — verifies credentials via `GET /wp/v2/users/me`.
- **`auth clear`** — removes the credential from the keychain.

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
git clone https://github.com/<your-fork>/wordpress-file-sync.git
cd wordpress-file-sync
pnpm install

# Build everything
pnpm -r build

# Run unit tests across all packages
pnpm -r test

# Run the CLI from source against a real WP
pnpm --filter @wpsync/cli dev -- pull

# Run the GUI in dev mode (Vite renderer + tsx-driven Electron main)
pnpm --filter @wpsync/gui dev

# Build distributable installers (electron-builder)
pnpm --filter @wpsync/gui dist
```

### Workspace layout

```
packages/
├── core/   # @wpsync/core — sync library, no Node-CLI/Electron deps
├── cli/    # @wpsync/cli  — bin: wpsync (commander)
└── gui/    # @wpsync/gui  — Electron main + React renderer (Vite)
test/
├── fixtures/wordpress/   # docker-compose.yml + wp-init.sh
└── integration/          # cross-package end-to-end tests
```

The core library is the public API; CLI and GUI are thin shells on top of it. If you're contributing, start by reading `packages/core/src/index.ts`.

### GUI dev mode

```bash
pnpm --filter @wpsync/gui dev       # Vite + Electron with hot-reload
pnpm --filter @wpsync/gui build     # production tsc + vite build
pnpm --filter @wpsync/gui start     # run the built app
```

The GUI's main process imports `@wpsync/core` directly and exposes a typed bridge to the renderer via `contextBridge`. There is no subprocess or stdin/stdout IPC between the renderer and the sync logic — only Electron's main↔renderer message channel.

### Building installers

```bash
pnpm --filter @wpsync/gui dist        # bundle for the host platform → packages/gui/release/
pnpm --filter @wpsync/gui dist:win    # Windows NSIS installer
pnpm --filter @wpsync/gui dist:mac    # macOS DMG (Mac only)
pnpm --filter @wpsync/gui dist:linux  # Linux AppImage
```

> **Windows note:** the `dist:win` script runs a tiny shim that wraps the bundled 7-Zip and skips the macOS-only entries inside the code-signing toolchain archive (which would otherwise need *Developer Mode* or admin to extract). The shim is built from a C# source file using `csc.exe` from .NET Framework 4 — present on every Windows install since Windows 8, no extra tooling required.

## Testing

### Unit tests

```bash
pnpm -r test                          # all packages
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

- **`pull-pagination.test.ts`** — fresh init + `pull --full --type post`; asserts ≥101 seed files in `posts/`, which is only achievable if the paginator advanced past the per_page=100 cap.
- **`pull-roundtrip.test.ts`** — pull → edit a unique marker into a seed post's body → push → full-pull; asserts the body bytes after push equal the body bytes after re-pull.
- **`conflict-halt.test.ts`** — pull a seed post, locally edit + bump mtime, mutate the same post server-side via `wp-cli`; asserts both `wpsync pull` and `wpsync push` exit 4, the local file is untouched, and the server's title is unchanged.
- **`tombstone-no-force.test.ts`** — create a fresh post on the server, pull it, set `status: trash` locally, push; asserts the local file is gone, the server post is in `trash` status (not purged), and `wp post update --post_status=draft` successfully restores it — proving `force=true` was never sent.

CI runs the Docker integration suite on `ubuntu-latest` only (Docker on Windows runners is flaky); unit tests run on Ubuntu, Windows, and macOS so `keytar` is exercised on every supported platform.

> **Note for non-SSL local fixtures:** WP 6.x disables Application Passwords on plain HTTP unless the site is marked as a local environment. `docker-compose.yml` sets `WP_ENVIRONMENT_TYPE=local` for that reason. `wp-init.mjs` also patches Apache's default `AllowOverride None` so WordPress's `.htaccess` `Authorization`-header rewrite actually fires.

## Project status

`wpsync` v1 is **feature-complete and end-to-end-tested**. 109 unit tests + 4 integration tests pass on every run. The PRD §8 acceptance criteria — round-trip body integrity, ≥101-item pagination, conflict halt with exit 4 and zero writes, and tombstone DELETE without `force=true` — are all verified against a real Dockerised WordPress instance. The Windows installer build works without Developer Mode via a small 7za extract-time shim.

| Milestone | Scope | State |
|-----------|-------|-------|
| **M1** | Skeleton: pnpm workspace, three packages, tsconfig refs, vitest, lint, CI | ✅ done |
| **M2** | Read-only pull (CLI `init` + `auth set/test/clear` + `pull --full --type --dry-run`, auth via keytar with encrypted fallback) | ✅ done |
| **M3** | Push with write-back and `mtime` adjustment (CLI `push --type --dry-run`); round-trip integrity verified end-to-end | ✅ done |
| **M4** | Conflict detection (exit 4, zero writes), tombstone deletion (DELETE without `force=true`), `wpsync status`, `--force-pull` / `--force-push` | ✅ done |
| **M5** | GUI shell — Electron 41 + React 19 + Vite 8: Setup wizard, Main view with progress events, IPC bridge over `contextBridge` | ✅ done |
| **M6** | Per-slug ConflictModal, Settings screen (test creds, change password, switch folder, open config), electron-builder packaging (Windows/Mac/Linux configs) | ✅ done |
| **M7** | Hardening: exponential-backoff retries with transient-network-error retry, Retry-After on 429, friendly 401/403/404/ECONNREFUSED/etc messages, push mtime race guard, dry-run output polish | ✅ done |
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

**`401 Unauthorized` when running `wpsync auth test`.** Confirm the Application Password is correct (no spaces — wp-admin shows it with spaces for readability, but they're optional), the user has `edit_posts`, and the site is reachable over HTTPS. On Windows, keychain entries are scoped to your Windows user profile; switching users invalidates them — re-run `wpsync auth set`.

**`wpsync pull` writes nothing even though I edited a post in wp-admin.** WordPress only updates `modified_gmt` when `post_content` or specific meta fields change; pure taxonomy edits via wp-admin can leave it unchanged. Pulling will catch the drift on the next content edit, or run `wpsync pull --full` to force a full re-pull.

**Pagination seems wrong.** Some WP installs sit behind reverse proxies that strip the `Link` response header. `wpsync` falls back to `X-WP-TotalPages` automatically; run with `--verbose` to see which path it took.

**Conflict on a post I haven't touched locally.** Saving a file in your editor updates its `mtime` even if the bytes didn't change. Either re-pull with `--force-pull` to resync, or only save files when you actually edit them.

**`keytar` fails to load on Linux.** Install `libsecret-1-dev` (Debian/Ubuntu) or `libsecret-devel` (Fedora). On headless servers, `wpsync` falls back to an encrypted `.wpsync/secrets.json` automatically — check the warning in the command output.
