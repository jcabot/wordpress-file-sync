#!/usr/bin/env bash
# wpsync GUI launcher — installs deps, starts dev server, opens browser.
set -e
cd "$(dirname "$0")/../.."
pnpm install

URL=http://localhost:5173
if command -v open >/dev/null 2>&1; then
  (sleep 2 && open "$URL") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 2 && xdg-open "$URL") &
fi

export WPSYNC_DEV=1
pnpm --filter @wpsync/gui dev
