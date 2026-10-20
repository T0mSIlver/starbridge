---
name: verify-desktop
description: Launch, drive and prove Starbridge's desktop app (the Electron window and its notifications, built for macOS, run under xvfb on Linux) for verifying a PR that changes what the desktop app shows or does (sign-in, pairing, answering from a notification, the menu bar dot). Use with the global `verify` skill, to read CI's desktop evidence comment, or when a risk needs the real app.
---

# Verify the desktop app

The whole product runs on one machine: the real server on a fresh database,
the built web page, the real CLI standing in for an agent's machine, the web
e2e's stand-ins for GitHub sign-in and Web Push, and the Electron app, driven
through Playwright's `_electron` under `xvfb-run`. The driver is
`desktop/test/stack.ts`; CI runs it as `desktop end to end`.

## What CI already proves

- **The desktop evidence comment** (marked `<!-- starbridge-evidence desktop -->`,
  docs/ci.md "Evidence"): the steps the run drove, and each window screen that
  changed against main, before and after, at seven stops (sign-in, keys, empty
  inbox, pairing, a question, Quotas, Settings) in light and dark. The run's
  `desktop-evidence-app-<tree>` artifact holds every screenshot with the boxes
  left out of the comparison:

  ```bash
  gh run download <run id> -R T0mSIlver/starbridge -p 'desktop-evidence-*' -D <scratch>/evidence
  ```

  Check the comment's commit is the PR's head before you judge it.
- `desktop end to end` green: the app signs in through the browser, pairs a
  machine, switches tabs without a request, answers `ask --wait` from its
  notifications by a button and by a typed reply, closes a notification when the
  window answers, and changes the menu bar's tooltip with Needs you.

The macOS-only parts (the real menu bar icon, the system's notifications, the
window frame, signing) run in `whole product on macOS` and the release; this
run has no menu bar to shoot.

## Launch

From the repository root, after `pnpm install` (and, once, `pnpm exec
install-electron` in `desktop/`, which reads Electron from `~/.cache/electron`
when it is there):

```bash
pnpm --filter @starbridge/desktop build
EVIDENCE=<scratch>/evidence TMPDIR=<scratch> xvfb-run -a node desktop/test/stack.ts
```

It builds the web page (about a minute), starts the stack on free ports,
launches the app with its own user-data dir, and ends with
`desktop stack test passed`, or a stack trace, with `starbridge-desktop-failure.png`
in `TMPDIR` and the page's text in the log (`[failure] …`). `EVIDENCE` is
optional: it keeps the screens and `manifest.json`. It stops everything it
started when it exits. A whole run takes a few minutes; CI's watchdog stops it
at 10.

## Doctor

The log's first lines are `[services] …ready`, `[server] starbridge server on
port …`, `[web] … Ready`; then `==` step lines. A hang names its step: the last
`==` line. The server's port is random, so runs can share the box; each has its
own temp folder and user-data dir. `which xvfb-run bun node` must all answer;
Node 24 runs the TypeScript directly.

## Drive

`stack.ts` is a script, not a harness. For a PR's own check, copy it to your
scratch folder (its imports are relative to `desktop/test/`, so keep the copy
there and delete it afterwards) and add steps where the app is in the state you
need:

- `page`: the window's page (`app.firstWindow()`). Select by role and label:
  `page.getByRole("button", { name: "Create the account" })`.
- `main(g => …)`: runs in the app's main process against what the test records
  in place of the OS: `g.shown` (notifications, with `title`, `actions`,
  `hasReply`), `g.closed`, `g.tips` (the menu bar's tooltips), `g.outside` (what
  went to the browser). A notification's button is `n.emit("action", {}, i)`; its
  typed reply `n.emit("reply", {}, "text")`.
- `cli(name, args, home)`: the CLI as a machine, e.g. `ask("Question?", "--option",
  "A", "--option", "B")` in the file.
- `shoot(page, "<stop>")` with `EVIDENCE` set: both schemes, with the masks.

## Fake users

One account (GitHub user 4242), the app as its first device, and a machine
`devbox` paired in the run. A second machine: `cli("pair", ["pair", "--name",
"other"], join(tmp, "other"))`, approved from the app's Add a device page as the
file does for `devbox`. A second device means a second app (`electron.launch`
with another `--user-data-dir`) or a browser as in verify-web.

## Evidence

- Look at every image you rely on, at full size, with the Read tool, and write
  what it shows and whether it is right.
- The side effects the run asserts: the CLI's `Answer to d_… (<question>): <answer>`
  line, the notification's `title` and `actions`, the tray's tooltip
  (`Starbridge: 1 needs you`, then `Starbridge`).
- Notifications and the tray are recorded, not drawn: no screenshot shows them.

## Peers and matrix

- Light and dark at each stop; the window is about 1200 px wide under xvfb.
- The window's rail and lists against the web at the same width (verify-web):
  the app adds only what a browser cannot.
- Two runs of the same tree differ by at most 0.03% of pixels (measured on 14
  screenshots), against the comment's 0.2% threshold.

## Cleanup

`stack.ts` kills the processes it started. A run killed from outside leaves
its children: find them by the run's temp folder in their command line and kill
those PIDs, never by pattern (`pkill -f` kills your own shell).

## Rules

- Never weaken a step to make it pass: a missing precondition is a reported
  failure.
- Electron's `nativeTheme.themeSource` does not reach the page under xvfb: the
  scheme comes from Playwright's `emulateMedia`.

## Features

[features/README.md](features/README.md) indexes one file per feature.
