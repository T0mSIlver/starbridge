# Starbridge agent guide

Starbridge lets one person supervise their coding agents from an Android app
and a web page with the same features: questions that agents ask and the owner
answers with one tap, pushed back into the waiting session; runs; permission
prompts; and AI plan quota windows read from CodexBar. `SPEC.md` indexes the
product decisions and their reasons, one file per area under `spec/`;
`PROTOCOL.md` holds the wire format and `DESIGN.md` the look.

## What to read

Read the spec files for what your change touches, whole, rather than
grepping one big file:

| You change | Read |
|---|---|
| a new feature or a principle | `spec/product.md` |
| `server` | `spec/server.md`, and `spec/push.md` or `spec/sign-in.md` when it touches them |
| `web` | `spec/clients.md`, `spec/web.md`, `spec/items.md` |
| `android` | `spec/clients.md`, `spec/android.md`, `spec/items.md`, `spec/push.md` |
| `desktop` | `spec/clients.md`, `spec/desktop.md` |
| a feature a user sees in one client | `spec/parity.md` too |
| `cli`, `mod`, `plugin` | `spec/machines.md`, `spec/harnesses.md`, `spec/platform-facts.md` |
| `packages/protocol`, keys, pairing | `spec/keys-and-trust.md`, `PROTOCOL.md` |
| `deploy`, `.github`, a release | `spec/releases.md`, `spec/hosted.md` |

## Layout

pnpm monorepo on Bun. `packages/protocol` (shared types, crypto and test
vectors), `server` (Hono, `bun:sqlite`), `web` (Next.js), `android` (Kotlin,
Compose), `desktop` (Electron, the macOS app), `cli` (the `starbridge`
command and its local agent), `plugin` and
`mod` (Claude Code's plugins; `mod` also holds the Pi and opencode ones),
`deploy` (the hosted instance), `demo` (the Play reviewers' demo server),
`evals` (the skill eval and the load test), `docs` (pages served under
/docs).

## Working rules

- One issue, one branch, one PR that says `Closes #n`.
- Keep a PR to its issue. A `packages/protocol` change that another change
  needs goes in its own small PR first.
- Fill the PR's "Release notes" section: one `Product: line` per product a user sees change
  (Android, Web, Desktop, CLI, Server, Docs), or `None`. The release groups them by product.
- Merge `main` into your branch only when it conflicts or you need a fix from `main`. Every
  push reruns the whole CI, and a PR merges without being up to date.
- Before a PR is ready, run the checks in
  [CONTRIBUTING.md, "Develop"](CONTRIBUTING.md#develop).
- A Settings row you add or rename follows DESIGN.md's rule on Settings
  copy: a title that stands alone, a subtitle only when it must.
- When a change makes or changes a product decision, update its file under
  `spec/`: the rule, why in a clause, and the issue. Replace what it
  supersedes. A feature added to or changed in one client updates its row in
  `spec/parity.md`, and the PR opens an issue for each client the row says
  should follow.

## CI runners

A Linux job on the self-hosted boxes takes its `runs-on` from a repository
variable, a JSON array of labels, with GitHub's runner as the fallback:
`TRUSTED_RUNNER` for pushes to main, deploys and releases, `PR_LIGHT_RUNNER`,
`PR_HEAVY_RUNNER` and `PR_DOCKER_RUNNER` for pull requests from this
repository's branches. Never send a pull request job to `TRUSTED_RUNNER` or
`ANDROID_RUNNER`, and never name a runner label in a workflow directly.
Windows, macOS, KVM and Electron jobs stay on GitHub's runners. A job must not
rely on an earlier one's files, and must run beside another on one box: no
fixed host port, unique container, Compose project and image names.
[docs/ci.md](docs/ci.md) has the boxes and how to debug them.

## Personal setup

Your own machine, paths and habits go in `CLAUDE.local.md` or
`AGENTS.override.md`, both ignored by git, not in this file.
