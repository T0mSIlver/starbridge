---
name: verify-web
description: Launch, drive and prove Starbridge's web app (Next.js page, server, CLI as the agent) on one machine, for verifying a PR that changes what the web shows or a core flow (ask and answer, Web Push, pairing and sign-in, permission prompts). Use with the global `verify` skill, when a risk needs the real app rather than CI's evidence, or to read that evidence.
---

# Verify the web app

The whole product runs on one machine: the server on a fresh database, the
built web page, the real CLI standing in for an agent's machine, Firefox
through Playwright, and stand-ins for GitHub sign-in and the Web Push service
(`web/e2e/services.ts`). The stack is `web/e2e/stack.ts`; CI's e2e
(`web/e2e/run.ts`) and the scenario driver (`web/e2e/drive.ts`) both use it.

How much proof a PR needs is the global `verify` skill's call. What this repo
already proves on every PR that touches the web:

- **CI's evidence comment** (marked `<!-- starbridge-evidence -->`, docs/ci.md
  "Evidence"): the steps the e2e drove, and each screen that changed against
  main, before and after. The run's `evidence-<part>-<tree>` artifacts hold
  every screenshot at 360, 768 and 1280 px in light and dark, and a
  Playwright trace per browser:

  ```bash
  gh run download <run id> -R T0mSIlver/starbridge -p 'evidence-*' -D <scratch>/evidence
  ```

  Check the comment's commit is the PR's head before you judge it.

Drive the app yourself only for what that doesn't cover.

## Launch

From the repository root, after `pnpm install` and, once,
`pnpm --filter @starbridge/web exec playwright install firefox`:

```bash
CI=1 xvfb-run -a node web/e2e/drive.ts .agents/skills/verify-web/scenarios/ask-answer.ts <scratch>/out
```

`drive.ts` builds the web app (about a minute), starts the stack on free
ports, signs in through the GitHub stand-in, creates the first device's keys,
pairs a machine named `devbox`, then runs the scenario. It prints
`SCENARIO PASSED`, or `SCENARIO FAILED` with `failure.png` in the out dir.
It stops everything it started and deletes its data when it exits. `CI=1`
keeps a real `codexbar` on the box out of the quota steps.

A whole part of CI's e2e, with its evidence:

```bash
CI=1 EVIDENCE=<scratch>/inbox E2E_SHARD=inbox xvfb-run -a node web/e2e/run.ts
```

Parts: `inbox` (about 2 min), `devices` and `snooze` (about 4 min each).

## Doctor

The driver's log shows `[server] starbridge server on port …` and
`[web] … Ready`, then the step lines (`== …`). No `SCENARIO …` line within
5 minutes means a step is waiting on a selector: the log's last `==` line
names it. Several runs can share the box: ports are random, and each run has
its own temp folder and browser.

## Drive

A scenario is a module whose default export takes a `Scenario`
(`web/e2e/drive.ts`):

- `page`, `context`: the signed-in browser, desktop width, light theme.
- `machine(name, args)`: the CLI as `devbox`, e.g.
  `machine("ask", ["ask", "--question", "…", "--option", "A", "--option", "B", "--wait"])`;
  `await x.waitFor(/regex/)` reads its output, `await x.exited` its exit code.
- `prompt(input)`: Claude Code's PermissionRequest hook on `devbox`, given
  `input` on stdin; resolves to what it prints once answered. Run
  `machine("perm-on", ["config", "permissions", "on"])` first.
- `services.waitFor(/"event":"push"/)`: the stand-ins' events (`subscribed`,
  `push`, `github-authorize`).
- `shot(name)`: the current page at 360, 768 and 1280 px, light and dark;
  returns the six paths.

Select by role and label, as `run.ts` does
(`page.getByRole("button", { name: "Allow" })`), never by class: CSS
module class names change with every build.

Write a PR's scenario in your scratch folder, importing
`<repo>/web/e2e/drive.ts` for the type, and quote it in the verdict.

## Fake users

One account (GitHub user 4242) and one machine come with every run. A second
browser: `await context.browser()?.newContext()`, then pair it by the code its
page shows, as run.ts's "add a second browser by pairing code" step does. A
second machine: `cli(...)` from `web/e2e/stack.ts` with another home under
`tmp`, paired as `drive.ts` pairs `devbox`.

## Evidence

- Look at every image you rely on, at full size, with the Read tool, and
  write what it shows and whether it is right.
- The CLI's output is the agent side's proof: `ask --wait` prints
  `Answer to d_… (<question>): <answer>`; the hook prints its decision JSON.
- The Web Push side: `services.waitFor(/"event":"push"/)` for the send, and
  the service worker's `getNotifications()` for what shows (`scenarios/push.ts`).
  Firefox draws notifications outside the page, so screenshots never show them.

## Peers and matrix

- Every screen at 360, 768 and 1280 px, light and dark. Phone and desktop
  layouts differ (a list and a detail pane from 600 px); check both.
- The favicon and the tab's icon beside other sites' pinned tabs; the logo
  mark in the header beside the text it sits with.
- A row against the rows above and below it; Settings rows against
  DESIGN.md's Settings copy rule.

## Cleanup

`drive.ts` and `run.ts` kill only the processes they started and delete their
temp folder; the out dir stays. A run killed from outside leaves its
children: find them by the run's temp folder in their command line and kill
those PIDs, never by pattern (`pkill -f` kills your own shell).

## Rules

- Screens that change between runs on their own are listed in docs/ci.md
  ("Evidence"). A change there alone is not the PR's.
- Runs inside an agent session strip its variables from the CLI's environment
  (`machineEnv` in stack.ts); otherwise questions carry that session's name.

## Features

[features/README.md](features/README.md) indexes one file per feature.
