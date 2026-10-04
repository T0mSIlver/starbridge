# Agent supervisor (working name)

Status: draft, 2026-10-04. No name and no GitHub repository yet. This folder is
the working copy until the owner picks a name.

## What it is

One place where the person running coding agents supervises them, from an
Android app and from a web page with the same features. You read what your AI
plans have left, answer the decisions your agents need from you, and see what
your machines are busy with.

The owner's own use sets the first version. On the phone he talks only to the
orchestrator (a Claude Code session that runs the other sessions) through the
Claude app's Remote Control. He sends short messages such as "fine, you can run
inference on my Mac, I'm not at the keyboard". At home he sits at the Mac, so
the web page is the main client there. Both clients have feature parity.

It starts generic so other people can use it. Owner-specific panels (his Mac,
his release) come as extensions.

## Version 1: two generic features

### 1. Quota windows

What each AI plan has left: the Claude weekly limit and 5-hour window, Codex
windows, Z.ai (GLM) 5-hour window, Mistral monthly credits, and any provider
CodexBar knows. Show used percent, reset time, and pace (whether you will run
out or leave headroom unused before the reset).

Alert when a window is about to reset with headroom unused. The owner's rules
treat unused headroom as waste: GLM's 5-hour window has no weekly cap, Mistral's
monthly credits expire, and the Codex weekly limit resets.

Source: CodexBar (github.com/steipete/CodexBar). Facts checked in the owner's
checkout at `~/work/CodexBar`, upstream `60c1adbce` (2026-10-04):

- The `codexbar` CLI runs on macOS and Linux. The owner's `quota` script on the
  dev box already wraps `codexbar usage --format json --provider <name>`.
- `codexbar serve` is an HTTP server with usage and cost JSON (`GET /usage`), a
  token-gated dashboard snapshot (`/dashboard/v1/snapshot`, token in
  `CODEXBAR_DASHBOARD_TOKEN`) and a web dashboard at `/`. It is plain HTTP;
  `--host 0.0.0.0 --allow-plain-http` serves the LAN, and its docs leave TLS to
  a reverse proxy (`docs/cli.md`, `docs/dashboard-api.md`).
- CodexBar's `VISION.md` says integrations beyond macOS "belong in separate,
  community-maintained projects consuming `codexbar serve` or `codexbar usage
  --json`; we link good ones from the README". An Android app consuming
  `codexbar serve` is that case.
- CodexBar also discovers agent sessions (Codex, Claude Code, Pi) locally and
  over SSH (`docs/agent-sessions-design.md`). That could feed a sessions panel.
- The owner contributes to CodexBar (the Mistral provider's Linux cookie and
  monthly plan work, upstream PR #4024).

What exists on phones (web research, 2026-10-04):

- CodexBar is MIT, about 22k stars, release 0.71.1 on 2026-10-03, 89
  providers.
- No official mobile app. The Android request (steipete/CodexBar#477) was
  closed as not planned on 2026-03-04. A personal Compose port exists
  (hyunnnchoi/CodexBar-android). An iOS fork, CodexBar-Mobile, syncs through its
  own iCloud container; its request for a stable snapshot interface upstream
  (steipete/CodexBar#4014) was closed as not planned on 2026-09-26.
- So the server should read `codexbar` JSON and tolerate schema changes, not
  embed CodexBar code.
- A closed-source Play Store app, "AI Usage: Claude & Gemini" (`u.sage`), has a
  usage widget. Its data source is unverified. CUStats Go is iOS only.
- No open-source Android app found that covers Z.ai or Mistral.

CodexBar extensions: CodexBar loads local provider plugins, one JS or TS file
each in `~/.config/codexbar/providers/` (`docs/plugins.md`). They run sandboxed:
HTTP through the host only, no subprocesses, no local files. They return a usage
snapshot, so they add providers, not panels.

### 2. Decisions as notifications

When an agent needs the owner, it posts a decision to the service. The owner
gets a notification with the options as buttons, the recommended one first, and
answers with one tap. The answer goes back into the waiting session.

A decision must stand alone. The owner reads it on a lock screen, away from the
code and in the middle of something else, so it carries everything needed to
decide:

| Field | Meaning |
|---|---|
| `question` | one sentence |
| `context` | why it is asked and what each option changes; links allowed |
| `options` | 2 to 4 choices, or none for a free-text answer |
| `recommended` | one of the options |
| `default` | what the agent does if nobody answers, and when |
| `source` | which session asked: machine, project, session id |

This is the schema the owner's `needs-you` skill already uses on its claude.ai
artifact page (`question`, `context`, `options`, `recommended`, `default`). The
service replaces that page.

How agents learn to use it:

- A global `CLAUDE.md` rule: "Whenever you need me, use the `<name>` skill."
- The skill explains how to post a decision, how to write one that stands
  alone, and how the answer comes back.

### Answers pushed into Claude Code

The service pushes answers to Claude; Claude does not poll with Monitor. Pushing
is more reliable, and a session that waits costs no tokens.

Claude Code mods (plugins of function hooks, introduced late September 2026)
can do this. Checked against the mod API types in the owner's
`orchestrator-cache` mod:

- A mod cannot listen on a port. It can make outbound requests with
  `$.http.fetch(url, { method, headers, body, socketPath })`, which resolves
  when the body is read, so it can hold a long-poll request open.
- `$.prompt.submit({ text })` submits a prompt into the session.
  `orchestrator-cache` already uses it to send a keepalive into an idle session.
- `$.clock.after` and `$.clock.every` give timers.

So the mod keeps one long-poll request open against the service. When the owner
answers, the service completes that request, and the mod submits the answer as
a prompt. The mod is also the showcase for mods that the owner wants.

The other path is Claude Code channels (code.claude.com/docs/en/channels,
research preview). A channel is an MCP server that pushes events into an open
session, and a channel that declares `claude/channel/permission` can also answer
tool permission prompts. But the session must start with `--channels`, a custom
channel needs `--dangerously-load-development-channels` and a confirmation at
each launch, and only allowlisted plugins register. The mod needs none of that,
so the mod is the first path.

To check by probe: whether a long-poll `$.http.fetch` has a timeout, and
whether `prompt.submit` from a mod reaches a session open in the Desktop Code
tab and in Remote Control.

## Owner extensions

### Prompt cache, and keeping the orchestrator warm

- Show each session's prompt cache: hit rate, tokens read, written and new, and
  the time left before the cache lapses. The owner's `prompt-cache-control` mod
  already computes all of it for the meter above the prompt; it can post the
  same numbers to the service.
- A switch to keep the orchestrator warm or let it go cold. The
  `orchestrator-cache` mod reads the mode from
  `~/.local/state/orchestrate/cache-mode` (`warm` or `cold`), which
  `/orchestrator-cache` writes today. The switch writes the same file.

### What the Mac is doing

What runs on the owner's Mac build host: speech or polish inference, builds,
the self-hosted CI runner, and the queue of runs waiting for it. Plus the "you
can use my Mac, I'm away" grant that today is a chat message to the
orchestrator.

This is specific to the owner's setup. CodexBar has a plugin system for usage
providers (`TestsPlugin/`, `docs/plugin-prototype.md`); this app needs its own
way to add panels like this one. Open.

### Today's release

What shipped in the daily localvoxtral release the owner dogfoods. Possibly
just a release page generated by the release script, rather than a panel.
How it generalizes is open.

## The owner's setup

- Network: a WireGuard VPN server on a mini PC is the entry point to the home
  network, and a reverse proxy routes to services by LAN IP. No Tailscale.
- Machines: the dev box (Linux, where agent sessions and `codexbar` run), the
  Mac (build host, CI runner, daily driver), the mini PC (always on).
- Phone: Pixel 11 Pro, Android. The owner built an Android app before
  (vidtheque) with Jetpack Compose and Material 3 Expressive.

## Open questions

1. Where the service runs: dev box, mini PC or Mac.
2. Relationship to CodexBar: a separate project consuming `codexbar serve`, a
   contribution to CodexBar, or both.
3. Phone notifications: Firebase Cloud Messaging, a self-hosted push server
   (ntfy, UnifiedPush), or the app polling. ntfy works without Google on a
   self-hosted server, and its `http` action buttons POST back on tap, with at
   most 3 buttons per notification.
4. Which agents can post decisions in version 1: Claude Code only, or any agent
   through an HTTP call or a CLI.
5. The name.

## Research log

- 2026-10-04: CodexBar facts from the owner's checkout and upstream docs. Mod
  API facts from `~/.claude/mods/orchestrator-cache/.claude-plugin/types`.
  Phone apps, channels and ntfy from web research the same day.
