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
  (Android, iOS, Web, Desktop, CLI, Server, Docs), or `None`. The release groups them by product.
- Merge `main` into your branch only when it conflicts or you need a fix from `main`. Every
  push reruns the whole CI, and a PR merges without being up to date.
- A test that fails and then passes on a rerun gets an issue the first time, never a silent rerun.
  `flakes.yml` lists them each night on the issue labelled `flaky`.
- Before a PR is ready, run the checks in
  [CONTRIBUTING.md, "Develop"](CONTRIBUTING.md#develop).
- Before a PR is ready, diff it against `main` (`git diff --name-only origin/main...`) for files
  outside the packages it is meant to touch, such as a copy of a package path at the repo root.
- Before review, check your change for the bugs reviews keep finding:
  - Reread or compare state you read before an `await` before you write it, since another tab,
    process or write in flight may have changed it.
  - Honour a new off, held, snoozed, revoked or signed-out state on every send, notify and poll
    path, and list those paths in the PR body.
  - Treat a read that fails as an error, never an empty value. Refuse malformed input instead of
    crashing, and let setup change only entries Starbridge wrote.
  - Search `spec/`, `docs/`, skills and comments for each behaviour you changed, and fix what no
    longer matches the code.
  - Make a rule the clients share read the same in TS, Kotlin and Swift, and give a new accept or
    reject rule a case in `packages/protocol/vectors/`.
- A Settings row you add or rename follows DESIGN.md's rule on Settings
  copy: a title that stands alone, a subtitle only when it must.
- Docs (`README.md`, `docs/`, `cli/README.md`, `server/README.md`) follow [docs/AGENTS.md](docs/AGENTS.md).
- A change to how one client behaves or what it says searches the other clients (web, Android,
  iOS, desktop) for the same rule or string. Fix them in the same PR when the fix is small;
  otherwise open an issue for each. Fixes that reached one client and not the others came back
  as bugs days later (#1372).
- When a change makes or changes a product decision, update its file under
  `spec/`: the rule, why in a clause, and the issue. Replace what it
  supersedes. A feature added to or changed in one client updates its row in
  `spec/parity.md`, and the PR opens an issue for each client the row says
  should follow. A PR that changes a client fills its `Parity:` line, which CI
  checks.

## The owner's rules

Load the `owner-charter` skill before you plan a change, ask the owner anything, or mark a PR
ready: it says what the owner decides on a card and what must hold before a merge. Starbridge
adds:

- A PR that touches `.github/` or `deploy/` is release or deploy work: label it `owner-review`,
  start its body with a three-line summary of that part, and merge it only with the owner's OK.
- The PR's "Blast radius" section holds the `blast-radius` write-up.
- Proof by driving the real app (`verify`) covers the core flows a change can reach: ask and
  answer from a session to a device and back, push notifications, pairing and sign-in, and a
  release's install and update.

### Repeated corrections and their checks

Each correction the owner made more than once, and the check that catches it (`correct` skill).
A row with no check is open work.

| Correction | Check |
|---|---|
| An icon or mark off-centre against its peers | none yet |
| Copy that reads like a model wrote it | none yet |
| One behaviour worded two ways | none yet |
| A Settings subtitle that repeats its title or isn't needed | none yet |
| Docs that no longer match the code | partial: `cli/test/contract.test.ts`, `cli/test/protocol-doc.test.ts` |
| A page, route or screen nobody asked for | none yet |
| A status claim without its run, file or screenshot | none yet |
| French times shown with AM/PM | desktop only: `desktop/test/unit/clock.test.ts` |

## Cloud sessions

- [CONTRIBUTING.md, "Set up a box"](CONTRIBUTING.md#set-up-a-box) has the environment's setup
  script.
- At each start and resume, a cloud session installs `owner-charter` and the skills it names from
  T0mSIlver/skills (`.claude/settings.json`). Other machines get them from the skills plugin.
- The GitHub proxy refuses GraphQL, so `gh pr` and `gh issue` fail. Use
  `gh api repos/T0mSIlver/starbridge/...` instead.
- Android, iOS and macOS build and test only in CI: push, then read the runs with `gh run list`
  and `gh run view`.
- For cards, set `STARBRIDGE_MACHINE` and allow `starbridge.run` in the environment's network
  access ([cli/README.md, "Cloud sessions"](cli/README.md#cloud-sessions)).

## CI runners

A Linux job on the self-hosted boxes takes its `runs-on` from a repository
variable, a JSON array of labels, with GitHub's runner as the fallback:
`TRUSTED_RUNNER` for pushes to main, `PR_LIGHT_RUNNER` and `PR_DOCKER_RUNNER`
for pull requests from this repository's branches. Never send a pull request
job to `TRUSTED_RUNNER` or `ANDROID_RUNNER`, and never name a runner label in a
workflow directly. A job that reads a signing or deploy key, or builds a file
a release signs, runs on GitHub's runners only (#1825). Windows, macOS, KVM, e2e
and Electron jobs stay on GitHub's runners. A job must not
rely on an earlier one's files, and must run beside another on one box: no
fixed host port, unique container, Compose project and image names.
[docs/ci.md](docs/ci.md) has the boxes and how to debug them.

## Personal setup

Your own machine, paths and habits go in `CLAUDE.local.md` or
`AGENTS.override.md`, both ignored by git, not in this file.
