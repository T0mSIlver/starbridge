# Starbridge agent guide

Starbridge lets one person supervise their coding agents from an Android app
and a web page with the same features: questions that agents ask and the owner
answers with one tap, pushed back into the waiting session; runs; permission
prompts; and AI plan quota windows read from CodexBar. `SPEC.md` holds every
decision with its date, the open questions and the research log; `PROTOCOL.md`
the wire format; `DESIGN.md` the look. Read the parts your change touches.

## Layout

pnpm monorepo on Bun. `packages/protocol` (shared types, crypto and test
vectors), `server` (Hono, `bun:sqlite`), `web` (Next.js), `android` (Kotlin,
Compose), `cli` (the `starbridge` command and its agent), `plugin` and `mod`
(Claude Code), `deploy` (the hosted instance), `evals` (the skill's evals),
`docs` (pages served under /docs).

## Working rules

- One issue, one branch, one PR that says `Closes #n`. Never push `main`.
- Stay inside your issue's paths. Changes to `packages/protocol` needed by
  another issue go in their own small PR first.
- Before a PR is ready: `pnpm test`, `pnpm typecheck` and `pnpm lint`; for
  Android, `./gradlew assembleRelease verifyRoborazziDebug` in `android/`.
- Write each decision and research finding into `SPEC.md` with its date.
- Never credit an AI in commits or PRs.

## Personal setup

Your own machine, paths and habits go in `CLAUDE.local.md` or
`AGENTS.override.md`, both ignored by git, not in this file.
