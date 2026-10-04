# Starbridge agent guide

Starbridge lets one person supervise their coding agents from an Android app
and a web page with the same features: AI plan quota windows (read from
CodexBar) and decisions that agents post and the owner answers with one tap,
pushed back into the waiting session. `SPEC.md` holds everything decided so far,
the open questions and the research log. Read it first.

## Status (2026-10-04)

Ideation. No code. Do not start implementation until the owner says the
ideation is done; then both features get built in parallel, fully.

Decided (details and dates in `SPEC.md`, "Decided"): MIT; free hosting on a
small EU VPS (Hetzner first, then netcup) and self-hostable from the same
image; GitHub sign-in; end-to-end encryption with a key pair per device and a
printed recovery key, built on libsodium; push through an owner-hosted relay to
Firebase, UnifiedPush for self-hosters; any agent posts decisions through HTTP
and a CLI; a Claude Code mod long-polls the server and submits the answer as a
prompt; quotas come from `codexbar` JSON through a small local uploader; a
separate project from CodexBar, to be linked from its README later.

Not decided:
- The technology. Proposed in `SPEC.md`: the owner's vidtheque stack (Kotlin,
  Compose, Material 3 Expressive on Android; Next.js on the web; design tokens
  from `DESIGN.md`), TypeScript for the server, CLI and mod, SQLite.
- The domain: later, something like `starbridge-app.dev`. starbridge.dev,
  .app, .com and .ai are taken; Starbridge.ai is an AI startup selling to the
  public sector.
- The repo stays private until there is something to show.

## Next topics to work through with the owner

1. The decision skill and the global `CLAUDE.md` rule that points agents to it:
   how to write a decision that stands alone on a lock screen.
2. Screens of the web page and the Android app.
3. The extension format for owner panels: what the owner's Mac is running
   (inference, builds, the CI runner and its queue), the prompt cache meter,
   the orchestrator keep-warm switch, today's release.
4. Probes before design hardens: does a long-poll `$.http.fetch` in a Claude
   Code mod time out; does `$.prompt.submit` from a mod reach a session open in
   the Desktop Code tab and one driven through Remote Control.

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
