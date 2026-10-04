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
| `source` | which session asked: machine, project, session id, and optionally its title and links to open it (Remote Control or claude.ai/code, Claude Desktop) |

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
  when the body is read. Probed 2026-10-04 (Claude Code 2.1.286): the host
  aborts every `$.http.fetch` that has no complete answer after 30 s, with
  "no complete answer within 30000ms". No option changes it.
- `$.process.run` (timeout up to 10 minutes) and `$.process.spawn` (no
  timeout; the child lives until the loop ends or the mod unloads) can run
  `curl` and hold a request open longer.
- `$.prompt.submit({ text })` submits a prompt into the session.
  `orchestrator-cache` already uses it to send a keepalive into an idle session.
- `$.clock.after` and `$.clock.every` give timers.

So the mod long-polls the service in cycles shorter than 30 s: the service
holds each request about 25 s, then answers "nothing yet", and the mod asks
again at once. When the owner answers, the service completes the open request,
and the mod submits the answer as a prompt. A cycle costs one small request, so
polling needs no `curl`. If the service later streams events, `$.process.spawn`
running `curl -N` can hold the stream open. The mod is also the showcase for
mods that the owner wants.

As built (#7, 2026-10-04): the mod polls through the CLI rather than with
`$.http.fetch`. It runs `starbridge answers --session <id> --wait 25` with
`$.process.run`. The keys stay in the CLI's key store and never enter the mod,
and the protocol code and its checks exist in one place. A lease file lets
one session per machine poll. The other sessions watch the CLI's state file and
claim their answers from it locally. `starbridge ask` records the asking
session, and the CLI hands an answer only to that session, once.

Changed (#35, 2026-10-04): the CLI hands an answer over again until the mod
confirms it with `starbridge answers --session <id> --ack <decision id>`, and
the mod rereads the session id before submitting. An answer that arrives during
a `/clear` waits for the session that asked, instead of going to the new one.
The CLI and the mod must be updated together: an older mod never confirms, so
it would get the same answer every cycle.

Changed (#48, 2026-10-04): agents never wait. The skill no longer offers
`ask --wait` or a background `starbridge wait`: an agent posts, keeps working,
ends its turn, and acts on the answer when the mod submits it. When a
decision's default time passes with no answer, the CLI hands the mod one line
for it (`No answer to <id> (<question>) by its default time <time>: apply your
default: <default>`), confirmed apart from the answer (`--ack <id>:default`),
so an answer that comes later still arrives. Before that line, the CLI fetches
any answer waiting on the server. Sessions that do not poll reread their
answers every 30 s, since a default time passing changes no file. After a
`/resume` the mod keeps polling under the resumed id (before, `session.end`
with reason `resume` stopped it for good, and no `session.start` follows).
The mod's longest wait after errors drops from 5 minutes to 1.

What the probe showed (2026-10-04, in the Desktop Code tab):

- Idle session: the submitted prompt starts a turn within 0.2 s, and the model
  reads it as "The <mod> plugin sent a message: ...".
- Mid-turn: the prompt waits and starts its own turn about 0.1 s after the
  running turn ends; it is never folded into the running turn. `submit`
  resolves only when that turn starts, so the poll loop must not await it.
- Remote Control: a prompt the mod submitted, idle or queued behind a turn the
  owner started from the phone, showed on the phone with the answer. Prompts
  from the phone reach hooks with origin `bridge`; typed ones with `composer`.
- Idle: polling and held requests kept running while the session idled
  (longest gap measured: 23 minutes).
- A hot reload of the mod aborts its in-flight requests at once.

The other path is Claude Code channels (code.claude.com/docs/en/channels,
research preview). A channel is an MCP server that pushes events into an open
session, and a channel that declares `claude/channel/permission` can also answer
tool permission prompts. But the session must start with `--channels`, a custom
channel needs `--dangerously-load-development-channels` and a confirmation at
each launch, and only allowlisted plugins register. The mod needs none of that,
so the mod is the first path.

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

- 2026-10-04. The owner's own instance is the hosted one on the VPS; no LXC
  on the Proxmox host (replaces the first LXC decision). Agents reach it over
  HTTPS; `codexbar` runs on the dev box through the uploader.
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

- 2026-10-04. Ideation done; the build plan below is approved. Stack: a pnpm
  monorepo on Bun (not Node), with `bun:sqlite`, Hono, and the CLI shipped as
  `bun build --compile` binaries as well as on npm; Next.js web; Kotlin and
  Compose on Android. Quota snapshots are end-to-end encrypted like
  decisions. Version 1 is quotas and decisions; owner panels wait for
  version 2. Web Push is in version 1.

- 2026-10-04 (late). Android is a flagship-standard Material 3 Expressive app,
  used fully and by the guidelines, nothing generic or improvised. Fonts are what a
  flagship Android app uses: Google Sans Flex (OFL on Google Fonts, the face of
  Google's own apps) on the Material type scale, not Archivo; monospace only
  for code. This replaces "Expressive parts only where they do a
  job" below. The web pairs with it without imitating Android.
- 2026-10-04 (late). Look (#49): the owner picked direction C, "Beacon", of
  three drafted on the options page (https://claude.ai/artifact/BNDBtkU1kP6MtXimyCrRTP),
  which also links the reference apps. Soft black (`#0c0c0c`) and neutral
  greys with no hue; amber is the only accent and means "needs you": open
  decisions, the recommended option, quota headroom left unused. Red only for
  "will run out"; "on pace" has no colour. Large M3 Expressive shapes (cards at
  28 dp, button groups with round ends), the expressive motion scheme, airy
  density. Light and dark both stay and follow the system. Android has a
  "Colours" setting: "Starbridge" (default, the fixed black palette) or
  "Match wallpaper" (Material You dynamic colour); under both, the amber
  accent and the quota state colours stay fixed. The themed
  monochrome launcher icon stays, since the owner turns it on in Wallpaper &
  style. The web uses the same faces (Google Sans Flex, Google Sans Code) with
  web components: list and detail panes, hover, keyboard keys. Tokens:
  `DESIGN.md`.
- 2026-10-04 (late). Before the owner starts using Starbridge: (1) the mod's push
  path must work end to end without any agent waiting on an answer: an agent
  posts a decision and keeps working; the answer arrives later as a prompt;
  (2) a design overhaul. The current look reads generic. The base becomes black
  and white (neutral greys), not blue-black, with few accents. A research session
  drafts directions from similar apps and the owner picks.
- 2026-10-04. Look: function over form. Monospace only for code (Markdown
  code blocks in a decision's context); numbers, ids and machine names use the
  sans face with tabular figures. Colours: `DESIGN.md`'s palette on both
  clients by default; Material You dynamic colour is an Android setting
  (changed by #49, below). Fixed
  colours only where
  they carry meaning: the "needs you" accent and the quota states (on pace,
  will run out, unused). Material 3 Expressive parts are used where they do a
  job: connected button groups for a decision's options, the large
  notification action buttons, spring motion on state changes (answered,
  approved), progress indicators for quota windows, predictive back and
  adaptive layouts (list and detail side by side on wide screens).

- 2026-10-04. Protocol (`PROTOCOL.md`, `packages/protocol`): sign, then seal;
  signatures cover the JSON body text as sent, so nothing re-serializes JSON.
  The directory is a hash chain (BLAKE2b) that clients pin; the recovery key
  co-signs its first entry. A pairing code
  carries an 80-bit secret the server never sees, which keys an HMAC on both
  pairing messages. The recovery seed shows as 24 BIP-39 words
  (`@scure/bip39`, audited, MIT).

- 2026-10-04. Server (#5): self-hosters sign in with `OWNER_TOKEN` (`POST /v1/auth/owner`); the
  Android app gets its GitHub session through a `starbridge://auth#session=` redirect. A session
  gets its device by writing the first or a recovery directory entry, or by fetching its own
  pairing result. FCM needs the relay because its credentials belong to the app's Firebase
  project; Web Push goes through the relay only when a server has no VAPID keys, and UnifiedPush
  always goes direct. The relay is open, rate-limited per IP, and only pushes ciphertext or ids.
  The answer long-poll's cap is `MAX_WAIT_SECONDS` (300) until #2 reports the mod's fetch timeout.

- 2026-10-04. CLI (#6): keys, token, directory cache and state live in
  `~/.config/starbridge` (or `$XDG_CONFIG_HOME`, `$STARBRIDGE_CONFIG_DIR`),
  files 0600, directory 0700. `starbridge wait` exits 2 when the default time
  passes unanswered. An answer reaches the agent as one line, `Answer to <id>
  (<question>): <choice>`; the mod (#7) should submit the same line. The npm
  package is a Node bundle (Node 22+); the release workflow builds
  `bun build --compile` binaries for Linux and macOS on a `cli-v*` tag and
  publishes to npm once `NPM_TOKEN` is set. The skill is `starbridge`, with
  the rule "Whenever you need me to decide something, use the `starbridge`
  skill."

- 2026-10-04. Deploy (#10): `starbridge.run` runs from `deploy/`: Docker Compose with Caddy
  (host networking, so rate limits see real IPv4 and IPv6 clients) in front of one server
  process with `RELAY_MODE` on, FCM and VAPID keys of its own, and GitHub sign-in. The image is
  built on the box by `deploy/deploy.sh` from a ref pushed to GitHub; a GitHub Actions deploy is
  a follow-up. Nightly `sqlite3 .backup` kept 14 days in `/var/backups/starbridge`. Login is
  `deploy` with the dev box key and sudo; root login and passwords are off. The web page is not
  served yet (#8); Caddy will route it on the same origin.
- 2026-10-04. The CLI takes a lock file (`.lock` in its config directory)
  around every read-modify-write of its files (#33). A directory refresh fetches
  outside the lock, then under it keeps the longer of its chain and the saved
  one, each required to extend the other's pin, so two CLI processes refreshing
  at once cannot roll the pin back.

- 2026-10-04. Push hardening (#27, #36, #37): quota snapshots skip Web Push, because browsers
  drop subscriptions whose pushes show no notification (Firefox after 16); the page fetches
  `GET /quota` on open. A device holds at most 10 push subscriptions and an account 30; an
  account has at most 4 pushes in flight and 200 waiting, each with a 10 s timeout. Pushes to
  subscription URLs connect to the exact address that passed the private-range check.

- 2026-10-04. Web page (#8): device private keys are non-extractable WebCrypto X25519 and
  Ed25519 keys in IndexedDB where the browser has them, raw libsodium keys otherwise. A sealed
  box opens with WebCrypto's X25519, HSalsa20 from `@noble/ciphers` (audited; libsodium.js's
  standard build lacks it) and libsodium for the rest; `packages/protocol` gained async sign,
  seal and open for keys it cannot hold. The page shares the server's origin: Next proxies
  `/v1` in development, the reverse proxy in production. The service worker shows a
  notification for every decision, and closes it once the decision is answered. A
  browser that signs in again binds the new session to its existing device by signing a
  server nonce with the device key (#28, `POST /v1/auth/bind`).

- 2026-10-04. Icon and brand (#32): the mark is a space elevator, flat: a
  planet's edge, a tether running off the top into space, and one amber
  climber on it, on DESIGN.md's dark bg in both schemes. Stars were ruled out
  as a cliché of AI tools; an ankh-like first draft (a ring station on top)
  was dropped. Amber stays fixed under Material You dynamic colour. No
  wordmark: the name is set in Archivo. Shapes and files: DESIGN.md, "Icon".

- 2026-10-04. Android (#9): the app ports `packages/protocol` to Kotlin and
  passes its vectors. A decision's options are a vertical connected button
  group, since options run up to 100 characters. The notification shows at
  most three options, recommended first; a fourth needs the app. Keys, session
  and decrypted state sit in files wrapped by a Keystore AES key that works
  while the screen is locked, so lock-screen buttons can sign. Signing out
  revokes the phone unless it is the last device. The build turns
  `google-services.json` into resources itself instead of applying the
  google-services plugin, so CI builds without it. GitHub sign-in uses PKCE
  (#34, server #39). When a session ends the phone keeps its keys, and the next
  sign-in binds the new session with the device key (#44); only a verified
  chain that revokes the phone wipes it.
- 2026-10-04. App sign-in (#34): the GitHub redirect to `starbridge://auth` carries a
  single-use code bound to a PKCE S256 challenge, and the app trades code and verifier for the
  session at `POST /v1/auth/app/session`. Chosen over Android App Links on
  `https://starbridge.run` because App Links bind one domain into the APK, so self-hosted servers
  could not use them, and verification can fail silently and fall back to the browser, which
  would leave the token in its URL. Left open: a hostile app can start its own sign-in with its
  own verifier, and if GitHub skips the consent screen for an app already authorized, it gets a
  session. App Links on the hosted domain, added on top later, would close that for
  `starbridge.run`.

- 2026-10-05. Specs for #57, #58, #60 and #62 are on the issues. Owner choices:
  a permission prompt can be denied from the Android lock screen, but allowing
  it asks for the unlock first. The phone may allow once, for the session, or
  always for the project (Claude Code's local project settings); "always"
  needs the app. Permission prompts get their own short-lived "Prompts" lane
  and notification channel, apart from the curated decisions in the inbox,
  because the Claude app already answers them for Remote Control sessions;
  Starbridge's gain is every session, machine and agent in one place. Custom
  visuals are MCP Apps only, plus an optional preview image for
  notifications; the CLI wraps plain images and diffs into MCP Apps. Visuals
  get no network access in v1.
- 2026-10-05. Releases and deploys (#64, #26): a `v1.2.3` or `v1.2.3-rc.4` tag runs
  `.github/workflows/release.yml`, which publishes a GitHub Release with the APK signed by the
  release key, the four CLI binaries, `SHA256SUMS` and notes generated from merged PRs; `-rc`
  tags are prereleases. The APK's versionCode is `MAJOR*1000000 + MINOR*10000 + PATCH*100`, plus
  the rc number or 99, so release candidates sort before their release. The release key is an
  RSA 4096 PKCS12 keystore, alias `starbridge`, kept in `~/.config/starbridge/secrets/` and in
  Actions secrets; losing it means a new app id, so it needs a copy off the dev box. A merge to
  main deploys from Actions once CI passes, over SSH with its own key, whose forced command can
  only deploy a commit that is on GitHub's main: the box fetches that commit itself with a
  read-only GitHub deploy key. `deploy/deploy.sh` stays for rollbacks and other refs. The
  `cli-v*` workflow folded into the release one.

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
  token, and the Claude Code mod long-polls the hosted API in cycles under 30 s, since
  mods can fetch any HTTPS URL.
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

## Technology (decided 2026-10-04, Bun replaces Node)

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

## Build plan (approved 2026-10-04)

Ideation closes with this plan. Owner panels (the Mac, the prompt cache, the
release) wait for version 2; version 1 is quotas and decisions.

### Pieces

```
agents --CLI/HTTP--> server <-- web page (Next.js, decrypts in the browser)
  ^  mod long-poll     |  --> push relay --> FCM --> Android app
uploader (codexbar) ---+
```

One pnpm monorepo:

| Path | What |
|---|---|
| `packages/protocol` | zod schemas, the envelope code on libsodium, test vectors as JSON that the Android tests read too |
| `server` | Hono on Bun, `bun:sqlite`, one Docker image; a flag runs it as the push relay |
| `cli` | `starbridge` on npm: `pair`, `ask`, `wait`, `quota push` (the uploader) |
| `mod` | the Claude Code mod: long-poll, then `$.prompt.submit` |
| `skill` | the decision skill and the `CLAUDE.md` rule |
| `web` | Next.js page |
| `android` | Kotlin and Compose app |
| `DESIGN.md` | design tokens, generated to CSS and to Kotlin |

### Keys and trust

- Every device (phone, browser) and every machine (where agents run) makes an
  X25519 key pair for sealed boxes and an Ed25519 key pair for signatures.
  Private keys never leave it.
- The account's directory lists those public keys. Each entry is signed by a
  device already in it; the first device signs itself. A machine joins with a
  pairing code that the CLI prints and a device approves. The recovery key,
  an Ed25519 seed printed as words when the first device is set up, can sign
  a new device once all are lost. Clients check the signatures, so the server
  cannot slip its own key in. Revoking is a signed entry too.
- A decision is sealed to each device's key and signed by the machine. The
  answer is sealed to the asking machine and signed by the device. Quota
  snapshots and alerts use the same envelope, so the server holds ciphertext
  only.
- Push carries the device's own ciphertext when it fits FCM's 4 KB, else the
  item id for the app to fetch.
- The uploader computes pace and the unused-headroom alerts (TypeScript, in
  `packages/protocol`), so the clients only render them.

### Screens (both clients)

- Inbox: open decisions, recommended option first, free-text answer when
  there are no options; answered ones below.
- Quotas: one card per window with used percent, reset time and pace.
- Devices and machines: approve a pairing, revoke, show the recovery key once.
- Android: answer from the notification's buttons, lock screen included.
- Web: Web Push notifications, decrypted in the service worker.

### Order

Wave 1 starts now; each later session starts when what it builds on merges.

1. Protocol, repo layout and CI (wave 1). Everything else imports it.
2. Mod probes (wave 1): long-poll timeout, `prompt.submit` in the Desktop
   Code tab and through Remote Control.
3. Web shell and `DESIGN.md` (wave 1): screens on fake data, token pipeline.
4. Android shell (wave 1): screens on fake data, Kotlin tokens from
   `DESIGN.md` once 3 pushes it.
5. Server with relay mode and Docker image (after 1).
6. CLI, uploader and decision skill (after 1).
7. Mod (after 2 and 5).
8. Web wired to the server, crypto, Web Push (after 3 and 5).
9. Android wired, crypto, FCM, notification actions (after 4 and 5).
10. Deploy on the VPS with Caddy (after 5; needs the owner's accounts).

Every PR gets a cross-vendor review; PRs touching keys or the directory get
two vendors at high effort. The orchestrator merges on green, squash.

## Accounts

Created 2026-10-04 by the owner, for #10. Secrets live only on the dev box, in
`~/.config/starbridge/secrets/` (directory 0700, files 0600); nothing secret
goes in git.

- Domain: `starbridge.run` at Porkbun, renews 2027-10-04 ($22.14 a year). DNS
  at Porkbun: `A 2.29.61.225`, `AAAA 2a01:4f9:c015:ac83::1`.
- Server: Hetzner Cloud project `starbridge`, `starbridge-1`, a CX23 in
  Helsinki, Ubuntu 26.04 LTS, backups on. Firewall `web` lets in only TCP 22,
  80 and 443. User `deploy` logs in with the dev box key
  `~/.ssh/starbridge_ed25519` and uses sudo; root login and passwords are off
  since 2026-10-04 (`deploy/README.md`).
- GitHub OAuth app `Starbridge` under T0mSIlver: client id
  `Ov23liEVyfnca8hO548x`, redirect URI
  `https://starbridge.run/v1/auth/github/callback`, user tokens expire. Secret:
  `github-oauth-client-secret`.
- Firebase project `starbridge-476f2`, Android app `dev.starbridge.app`
  (app id `1:342630184902:android:a77b6cd3da382eed23e4c7`, config
  `google-services.json`).
  Service account
  `firebase-adminsdk-fbsvc@starbridge-476f2.iam.gserviceaccount.com`, key:
  `fcm-service-account.json`.
- Web Push VAPID public key
  `BIt5Tdn6pZWUo5LqP_v3qQjpFQ0lWtWQWRYvymNPELFL5t8aN7vqlMLw1Wz3mT_HvPKdybR98QGi__88s-nnMvk`;
  private key: `vapid-private-key`.

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
- 2026-10-04: domains confirmed through registry RDAP and Porkbun prices.
  getstarbridge.app, starbridge.app, starbridge.dev and starbridge.io are
  registered (so the "no nameservers" check above missed some), and one
  Cloudflare account holds getstarbridge.dev, usestarbridge.dev and
  starbridgehq.dev. Free: starbridge.run ($4.12, then $22.14), starbridge.sh
  ($31.20, then $46.65), starbridge.tools. The owner bought starbridge.run.
- 2026-10-04: Android crypto. `lazysodium-android` 5.2.0 needs JNA's AAR
  (`jna@aar`) for its per-ABI native library; JVM unit tests use
  `lazysodium-java`, which bundles libsodium for desktop, so the same
  `LazySodium` API runs in both. The release build keeps JNA and Lazysodium
  from R8.
- 2026-10-04: CodexBar 0.160.0 on the dev box. `codexbar usage --provider
  <unknown>` exits 0 and prints every enabled provider, so the uploader keeps
  only rows whose `provider` matches. Mistral's windows carry no
  `windowMinutes`, so they get no pace and no alerts until CodexBar adds it.
- 2026-10-04: mod probe (#2), Claude Code 2.1.286, Desktop Code tab, a
  throwaway mod against a local Bun server. `$.http.fetch` held 1, 5, 15, 60
  and 117 minutes: every request aborted at 30.0 s ("no complete answer within
  30000ms"), the server saw the client close. `$.process.run` running `curl`:
  60, 300 and 590 s holds answered, a `timeoutMs` above 600000 is refused.
  `$.process.spawn` running `curl -N`: 60, 300, 900 and 3600 s holds
  answered on time. `$.prompt.submit` from an idle session: turn started after
  0.17 s. Pushed mid-turn: queued, own turn 0.1 s after `turn.complete`.
  Remote Control: twice the owner saw the mod's prompt and the reply on the
  phone; phone prompts arrived with origin `bridge`, typed ones with
  `composer`. A 30 s fetch poll loop ran unattended through a 23-minute idle
  gap (40 cycles, none missed), and the 60-minute spawn hold spanned several
  idle gaps; no longer gap was measured.
- 2026-10-04: mod live run (#7), Claude Code 2.1.287, a terminal session
  started with `--plugin-dir mod`, against a local server from `main` and a
  test device driven by a script. The session ran `starbridge ask`, and the
  device's answer arrived in the session as a plugin prompt 0.25 s after the
  device posted it. A decision asked from another session was stored but not
  submitted. The run found that the CLI from #18 read `/answers` entries as
  bare items, but the server wraps them as `{item, cursor, receivedAt}` (as
  PROTOCOL.md says). The CLI rejected every answer as malformed and moved its
  cursor past it. #7 fixes the CLI and its fake server.
- 2026-10-04: client tests (#24). The CLI and mod tests now run against the
  real server app on a random port (`@starbridge/server/test-support`),
  because the CLI's hand-written fake had drifted from the `/answers` shape.
  Two seams stay: injected 503s, and answers stored past the server's checks,
  which only a compromised server would send. Web fixtures are decrypted
  bodies checked by the protocol schemas; the web `Device` adds `kind`,
  `addedAt`, `lastSeen` and `status`, which no route returns yet.
- 2026-10-04/05: answers e2e (#48), Claude Code 2.1.289. `mod/e2e/run.ts`
  drove real interactive sessions (Sonnet, in tmux, with the mod through
  `--plugin-dir` and the skill in the project) against the server app on the
  dev box (test-support, owner-token sign-in), and a local relay that cut the
  connection for the outage. From the device's post to the prompt: idle
  0.03 s; mid-turn, queued 0.05 s after the turn ended; a new session after
  `/clear` 0.07 s, while the old session's answer stayed held and arrived 20 s
  after `/resume` (one poll cycle); after a hot reload 0.03 s; 2.3 s after a
  60 s outage ended; two sessions asking at once each got only their own
  answer in 3.5 to 4.7 s; a default-time notice 0.07 s after its time. Agents
  posted with the skill, kept working, ended their turn and never waited.
  Haiku 4.5 once claimed it had posted without running `starbridge ask`, so
  the agent cases run on Sonnet. Live on starbridge.run as devbox, under Remote
  Control: the owner tapped Yes on his phone; the prompt reached the session
  0.15 s after the answer's signed time (whole seconds, so at most 1.2 s), and
  showed in the Remote Control session on his phone. The run found that
  `/resume` fires `session.end` (reason `resume`) and no `session.start`, which
  had stopped the mod's polling for good.
- 2026-10-05: session title and links (#56, #61), Claude Code 2.1.286 on the
  dev box. The mod API has no session title or Remote Control URL:
  `$.session` gives the id, cwd, repo, surfaces and usage; a hook can set a
  title (`sessionTitle` on `SessionStart` and `UserPromptSubmit`) but not read
  one. The Bash tool's environment has `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`
  and, in the Desktop Code tab, `CLAUDE_CODE_HOST_SESSION_ID` (`local_<uuid>`).
  Claude Code keeps one record per running process in
  `~/.claude/sessions/<pid>.json` (`$CLAUDE_CONFIG_DIR/sessions` when set),
  with `sessionId`, `name` (the title the app shows; `nameSource` is `user` or
  `derived`), `hostSessionId` under Desktop, and `bridgeSessionId`
  (`session_<id>`) while Remote Control is on, `null` once it is off. The
  Remote Control URL is `https://claude.ai/code/<bridgeSessionId>`: in 6 of 6
  transcripts that printed one, it matched the transcript's `bridge-session`
  record (`cse_<id>`, same suffix). Every record in the 47 seen had `name`;
  `bridgeSessionId` was missing only in one Desktop record. Claude Code
  rewrites a record in place without truncating, so a shorter one can carry
  the tail of the longer one it replaced; the reader parses the first JSON
  object. So `starbridge ask` fills `sessionTitle` and the links from the
  record whose `sessionId` matches, newest `updatedAt` first (a resumed
  session can leave an older record), and the mod needs nothing new.
  The Desktop link `claude://claude.ai/epitaxy/<hostSessionId>` comes from the
  owner and was not opened from a test. Cloud sessions were not inspected, so
  the CLI never fills the `web` kind; `--link web=<url>` sets it.
- 2026-10-05: permission, progress and visuals research (specs on #57, #58,
  #60, #62). Claude Code 2.1.289: the `PermissionRequest` command hook waits up
  to 600 s, races the dialog (the person's answer wins), and does not fire in
  `bypassPermissions` mode or under `-p`; whether it fires for the prompts
  bypass mode still shows is unprobed. The mod API can hook
  `classic.PermissionRequest` and `tool.check`, and waits on `$` calls do not
  count against a hook's 10 s budget. The channels permission relay allows
  per call only and needs launch flags. Codex 0.160.0 has stable hooks with a
  `PermissionRequest` event (600 s) and `codex queue` to message an existing
  session. Gemini CLI, opencode and Cursor cannot answer a prompt from a hook.
  Android 16 Live Updates need `POST_PROMOTED_NOTIFICATIONS`,
  `setRequestPromotedOngoing` and `ProgressStyle` (androidx.core 1.17). MCP
  Apps (SEP-1865) has been a stable MCP extension since 2026-01-26:
  `ui://` resources of type `text/html;profile=mcp-app`, JSON-RPC over
  `postMessage`, and a sandboxed iframe with a CSP the host builds.
