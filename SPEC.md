# Starbridge

Status: draft, 2026-10-04.

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

## Decided

- 2026-10-04. The service runs in an LXC container on the owner's Proxmox host,
  the same machine as the dev box. CodexBar is installed in that container.
  Agents reach the service over the local network.
- 2026-10-04. A separate project that reads `codexbar` JSON. Ask upstream to
  link it from the README once it works.
- 2026-10-04. Any agent can post a decision, through HTTP and a small CLI.
  Claude Code also gets answers pushed back through the mod.
- 2026-10-04. The owner wants this to become a real app with real users, and
  is fine paying a little for that, for example to host push for every user.

- 2026-10-04. Push: the plan below, approved.
- 2026-10-04. The owner wants a fully hosted version: it would be his first
  hosted project. Build order: both features in parallel, fully, with agents.
  No implementation starts until the ideation is done.

- 2026-10-04. Hosted sign-in: GitHub.
- 2026-10-04. Hosted decisions are end-to-end encrypted: the server stores
  ciphertext, and only paired devices (phone, browser) and the posting agents
  hold keys.
- 2026-10-04. MIT licence, free hosting paid by the owner (CodexBar's model).

- 2026-10-04. Free hosting caps each account at about 5 machines. Budget
  €5 to €10 a month. A VPS, not the home network (keeps the service away from
  the owner's machines). Check Hetzner Cloud first (CX23 or CAX11, about
  €5.50 to €6 after the June 2026 increase), then netcup.

- 2026-10-04. Encryption: a key pair per device, plus a recovery key printed
  once. Use existing, audited libraries; invent no cryptography (below).
- 2026-10-04. Not a "bar". Version 1 is a web page and an Android app; a menu
  bar app may come later. Names ending in "bar" are out.
- 2026-10-04. Name: Starbridge (a starship's bridge, where the captain
  commands, and the bridge between all your agents). Domains not registered yet.

## Encryption, with existing libraries

- libsodium sealed boxes (`crypto_box_seal`, X25519 + XSalsa20-Poly1305): an
  agent encrypts each decision once per recipient device public key. Bindings
  exist for every client: libsodium.js (web, ISC licence), Lazysodium (Android),
  libsodium itself or a binding for the CLI and the server. The server never
  decrypts, so it needs no cryptography beyond TLS.
- The app's own code is the device directory: listing public keys, approving a
  new device from an existing one, revoking, and the recovery key.
- Not libsignal: AGPL-3.0, which conflicts with the MIT licence, and its
  ratchets solve chat problems this app does not have.
- Alternatives seen: HPKE (RFC 9180) through Google Tink and hpke-js; Matrix
  (encrypted rooms, device verification, its own push gateway), which brings a
  whole homeserver; Jazz, an end-to-end encrypted sync framework, TypeScript
  only.

## Fully hosted

A first sketch, to discuss:

- One server that runs both ways: hosted by the owner, or self-hosted from the
  same image (ntfy and Plausible work this way).
- Decisions need nothing local. Agents post to the hosted API over HTTPS with a
  token, and the Claude Code mod long-polls the hosted API, since mods can
  fetch any HTTPS URL.
- Quotas need a small local uploader, because `codexbar` reads cookies and
  credentials on the user's machine. It runs `codexbar ... --format json` on a
  timer and posts the snapshot. Credentials never leave the machine.
- Machine panels (the owner's Mac) come through the same uploader.
- The server stores other people's agent questions, which carry code context.
  Option: end-to-end encryption, where the server stores ciphertext and only
  paired devices (phone, browser) hold keys. It costs server-side search and
  makes the web page decrypt in the browser.

## Push to phones

Approved 2026-10-04:

- Each user runs their own service. The owner hosts one small push relay for
  every user. The relay forwards to Firebase Cloud Messaging (FCM), which
  delivers to the phone. FCM charges nothing per message, so the relay is the
  only cost: a small VPS.
- The service encrypts each payload with a key the phone and service share at
  pairing, so the relay and Google see only ciphertext. ntfy.sh (its Play
  build) and the Home Assistant app follow the same pattern.
- Self-hosters who want no Google in the loop pick UnifiedPush (ntfy or another
  distributor) instead.
- iOS later would need Apple's push service and a $99/year developer account.

## Open questions

1. Technology. Proposed below.

## Technology (proposed, not decided)

The owner's vidtheque already uses: Kotlin, Jetpack Compose with Material 3
Expressive, Hilt, Navigation 3, OkHttp and Firebase on Android; Next.js 16 and
React 19 on the web; design tokens generated from `DESIGN.md` frontmatter
(`web/scripts/tokens.mjs`); Caddy, Docker Compose and cloudflared to deploy.

- Android: the vidtheque stack.
- Web: Next.js, as vidtheque, with the same design-token pipeline, so the two
  clients share colours and type.
- Server, CLI and Claude Code mod in TypeScript, sharing one schema (zod):
  Claude Code mods are TypeScript already, and agents install the CLI with npm.
  SQLite at first; it stores ciphertext and device keys only.
- Deploy: Docker Compose and Caddy on the VPS; the same image is the self-hosted
  build.

## Research log

- 2026-10-04: CodexBar facts from the owner's checkout and upstream docs. Mod
  API facts from `~/.claude/mods/orchestrator-cache/.claude-plugin/types`.
  Phone apps, channels and ntfy from web research the same day.
- 2026-10-04: names. Peers frame themselves as a command centre (Omnara,
  Conductor, Vibe Kanban), a remote for the pocket (Happy, Paseo) or an approval
  layer (HumanLayer, gotohuman). None pairs quota windows with decisions.
  Taken or too close: AgentBar (scari/AgentBar, a macOS menu bar usage tracker),
  Wheelhouse (kunchenguid/wheelhouse, cross-repo decision cards), Hark (a
  webhook push app), Gaffer, Tiller, Foreman, Bellwether, Cairn. Still
  candidates: Askbar, Aye, Holler (bitpshr/holler, a 295-star CLI notifier),
  Tapline.
- 2026-10-04: VPS prices. Hetzner CX23 about €5.49 (up from €3.99 on
  2026-06-15), netcup moved to G12.5 on 2026-09-22 (+40%), OVH VPS-1 €6.49
  since 2026-04-01, Scaleway DEV1-S €6.55, DigitalOcean $12, Fly.io about $13,
  Oracle's free Arm tier cut and unreliable.
- 2026-10-04: name checks (GitHub search, `dig NS` for domains, Play search).
  Sayso: sayso.dev and getsayso.com taken, sayso.app shows no nameservers, at
  least five Play apps named SaySo. Futuristic real words (Conn, Uplink, Pylon,
  Tether, Overmind, Orrery, Subspace, Comlink, Flagship, Mothership) all collide
  on GitHub, Play or every domain. Least crowded: Starbridge (a starship's
  bridge, and bridging agents; Starbridge.ai is a funded AI startup selling to
  the public sector; starbridge.sh, .run and getstarbridge.app show no
  nameservers; no Play app) and Hailing (agents hail you, as in "hailing
  frequencies"; hailing.dev, .app and .sh show no nameservers; no Play app;
  "ride-hailing" is the common sense of the word). No nameservers is not proof a
  domain is free; confirm at a registrar.
