@echo off
REM wpsync GUI launcher — installs deps, starts dev server, opens browser.
cd /d "%~dp0..\.."
call pnpm install
start "" http://localhost:5173
set WPSYNC_DEV=1
call pnpm --filter @wpsync/gui dev
