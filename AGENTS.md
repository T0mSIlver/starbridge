# Starbridge agent guide

Starbridge lets one person supervise their coding agents from an Android app
and a web page with the same features: AI plan quota windows (read from
CodexBar) and decisions that agents post and the owner answers with one tap,
pushed back into the waiting session. `SPEC.md` holds everything decided so far,
the open questions and the research log. Read it first.

## Status (2026-10-04)

Building version 1: quota windows and decisions. The plan, the waves and the
issue for each piece are in `SPEC.md`, "Build plan". Stack: pnpm monorepo on
Bun, Hono, `bun:sqlite`, Next.js, Kotlin and Compose. Domain and hosting
accounts not set up yet; use local stubs until they are.

## How sessions work here

- One session per GitHub issue, in its own worktree and branch, one PR that
  says `Closes #n`. Never push `main`.
- Stay inside your issue's paths. Changes to `packages/protocol` from another
  issue go in their own small PR first.
- Before `gh pr ready`, run the `cross-review` skill and fix what it finds.
  Then message the orchestrator; it merges (squash).
- Never credit an AI in commits or PRs.

## Where the owner's related work lives (dev box)

- CodexBar fork checkout: `~/work/CodexBar` (the owner contributes upstream).
  `codexbar serve` and its dashboard API: `docs/cli.md`,
  `docs/dashboard-api.md`; user provider plugins: `docs/plugins.md`.
- `quota` (`~/.local/bin/quota`): the owner's wrapper over `codexbar usage`.
- Mods: `~/.claude/mods/orchestrator-cache` (keepalive via `$.prompt.submit`,
  mode file `~/.local/state/orchestrate/cache-mode`; mod API types under
  `.claude-plugin/types`), `~/.claude/skills/prompt-cache-control` (cache
  meter).
- `~/.claude/skills/needs-you`: today's decision page on a claude.ai artifact,
  whose schema Starbridge's decisions extend.
- `~/work/vidtheque`: the owner's Android and web app, the stack reference.

## Working rules

- The owner reaches the dev box over SSH and his phone; give ports and paths,
  not LAN URLs. His network: WireGuard on a mini PC, a reverse proxy by LAN IP,
  Proxmox (the self-hosted server would run in an LXC there).
- Write every decision and research finding into `SPEC.md` with its date, and
  commit and push.
- Subagents only for read-only research, on Sonnet.
