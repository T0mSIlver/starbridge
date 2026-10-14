#!/bin/sh
# Installs the workspace's dependencies in a new checkout or worktree, and says nothing when they
# match the lockfile already. Claude Code runs it when a session starts (.claude/settings.json);
# other harnesses and people run it by hand (#1655). The pnpm store is shared, so an install takes
# seconds, and `--offline` skips the registry unless the store lacks a package.
set -eu
cd "$(dirname "$0")/.."
# pnpm keeps a copy of the lockfile it installed from.
cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml 2>/dev/null && exit 0
log=$(mktemp)
if pnpm install --frozen-lockfile --offline >"$log" 2>&1 ||
  pnpm install --frozen-lockfile --prefer-offline >"$log" 2>&1; then
  echo "worktree-setup: installed dependencies with pnpm."
else
  tail -n 20 "$log"
  echo "worktree-setup: pnpm install failed (above); run it by hand." >&2
fi
rm -f "$log"
