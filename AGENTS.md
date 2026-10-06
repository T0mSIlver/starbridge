# Starbridge agent guide

Starbridge lets one person supervise their coding agents from an Android app
and a web page with the same features: questions that agents ask and the owner
answers with one tap, pushed back into the waiting session; runs; permission
prompts; and AI plan quota windows read from CodexBar. `SPEC.md` holds the
product decisions and their reasons, by area; `PROTOCOL.md` the wire format;
`DESIGN.md` the look. Read the parts your change touches.

## Layout

pnpm monorepo on Bun. `packages/protocol` (shared types, crypto and test
vectors), `server` (Hono, `bun:sqlite`), `web` (Next.js), `android` (Kotlin,
Compose), `cli` (the `starbridge` command and its local agent), `plugin` and
`mod` (Claude Code's plugins; `mod` also holds the Pi and opencode ones),
`deploy` (the hosted instance), `demo` (the Play reviewers' demo server),
`evals` (the skill eval and the load test), `docs` (pages served under
/docs).

## Working rules

- One issue, one branch, one PR that says `Closes #n`.
- Keep a PR to its issue. A `packages/protocol` change that another change
  needs goes in its own small PR first.
- Before a PR is ready, run the checks in
  [CONTRIBUTING.md, "Develop"](CONTRIBUTING.md#develop).
- When a change makes or changes a product decision, update its section of
  `SPEC.md`: the rule, why, and the issue. Replace what it supersedes.

## Personal setup

Your own machine, paths and habits go in `CLAUDE.local.md` or
`AGENTS.override.md`, both ignored by git, not in this file.
