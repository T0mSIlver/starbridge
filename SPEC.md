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

Changed (#68, part 2, 2026-10-05): the mod talks to the machine's agent over its unix socket
with `$.http.fetch`. Each session sends `hello`, long-polls its own events (`wait=25`), submits
them and acks them; it runs no CLI, takes no lease and watches no file. When no agent answers
`GET /v1/status` with a 2xx (none installed, stopped, or a 426), the mod runs the CLI path above
and checks for the agent every 30 s, so machines without the agent keep working until setup
ships. Both paths share the set of submitted, unconfirmed lines, so a switch submits nothing
twice. The "agent not running" status line waits until the CLI path goes.

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
- 2026-10-05. Android Beacon (#63): Material's `primary` role is `fg`, so stock
  filled buttons are black or white and only the recommended option and an
  approval are amber; under "Match wallpaper" `primary` comes from the
  wallpaper. A decision's options form one row of connected buttons when every
  label fits on one line, each as wide as its label needs, and a stacked group
  otherwise. Google Sans Flex ships instanced to its weight and optical-size
  axes (410 KB instead of 4.1 MB), and each type role sets `opsz` to its size.
  The notification's `setColor` amber shows on Android 12 to 15; Android 16
  draws the app icon and tints the actions itself.
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
- 2026-10-05. Per-account bounds before hosted signups (#65): every route that stores
  something has a cap or a retention rule, and the writes that grow it a rate limit, sized for an
  orchestrator with 10 sessions asking a few hundred decisions a day. Answered decisions and
  their answers are kept 7 days, unanswered decisions and quota snapshots 30; 10000 stored
  decisions and 128 MB per account; directories end at 200 entries, which is about 100 add and
  revoke pairs; an account that reaches it needs the operator to reset it. The numbers live in
  `server/src/limits.ts` and PROTOCOL.md, "Limits".
- 2026-10-05. Setup (#68, spec on the issue): one `starbridge agent` per
  machine, a user service (systemd or launchd), owns the keys and the server
  connection, uploads quotas, and routes answers, permission prompts,
  control sets and runs to sessions over a unix socket. The mod becomes a
  thin client of it; CLI commands fall back to talking to the server
  themselves when no agent runs (owner's choice). Entry points: `curl
  -fsSL https://starbridge.run/install.sh | sh`, a Homebrew tap and npm
  (owner's choice). The repo is a Claude Code marketplace with two plugins,
  `starbridge` (skill, hooks, setup command) and `starbridge-mod`, split
  so that builds refusing mods keep the rest. The plugin's `SessionStart`
  hook injects the skill rule instead of editing CLAUDE.md (owner's choice).
  No public release date: the owner ships when satisfied.
- 2026-10-05. Starbridge builds on Claude Code and Codex and does not replace
  what they already do well (owner). Session controls (#58) are dropped from v1:
  a list of 20 or more live sessions costs a write per change, all for one
  setting that only an orchestrator needs, and the owner's orchestrator-cache
  mod covers it. Runs (#60): nothing is timed automatically. The owner writes
  rules in plain words, which the plugin's SessionStart hook loads. The agent
  wraps a matching command, chained or not, in `starbridge run --title` and
  says why it reports the run, e.g. "Mac e2e (uses your session and
  keyboard)". The phone shows the title, the reason, the time elapsed and any
  progress the output prints, then pass or fail. Visuals (#62) are images
  attached to a decision, encrypted like its text, plus links. For anything
  interactive the agent links a Claude artifact, which the Claude app opens.
  MCP Apps are dropped from v1, which supersedes the visuals choice above.
- 2026-10-05. Provider colours and "Match wallpaper" (#72): a quota card shows
  a dot in the provider's lab colour before its name (owner's choice: no
  logos). The colours are CodexBar's `ProviderBranding.color` for all 87
  providers, made lighter or darker per scheme, only as far as 3:1 against
  the grounds needs. Under "Match wallpaper", Android screens take every
  neutral and component colour from Material's roles, so all of them follow
  the wallpaper, the splash (Android 13+) and the notification accent
  (Android 12 to 15) included. Only amber, the quota states and the
  provider dots stay fixed. Measured on warm, cool and low-chroma seeds:
  the fixed colours keep 4.5:1 as text and 3:1 as dots; the wallpaper's
  `fg3` reaches 3.8:1 on light cards, above the default palette's 3.3:1.
- 2026-10-05. Install, update and signing (#68, part 4): the release workflow signs `SHA256SUMS`
  with minisign in CI (the owner's call, replacing "not in CI" in #68's spec); the secret key is
  in `~/.config/starbridge/secrets/minisign.key` and the `MINISIGN_SECRET_KEY` Actions secret, the
  public key in `cli/minisign.pub`, `install.sh`, the binary and the CLI README. `install.sh` is a
  release asset and checks the signature with minisign, or with OpenSSL 3 when minisign is
  missing, so most machines need nothing extra. The tap is `T0mSIlver/homebrew-starbridge`
  (`brew install T0mSIlver/starbridge/starbridge`, not `T0mSIlver/tap`), private like the main
  repo until both go public; the workflow commits the formula there with a write deploy key
  (`HOMEBREW_TAP_DEPLOY_KEY`) on non-rc tags. npm gets rc versions under the `next` dist-tag.
  `starbridge update` replaces script installs only and points brew and npm installs at their
  manager; `starbridge uninstall` removes the binary, and part 3 adds the service, plugins and
  config to it. Release downloads need the repo public.
- 2026-10-05. Runs (#60, built): a run is one sealed `run` item that the machine
  re-posts under its id; the server keeps the latest (`ITEM_KINDS` `updates`), at
  most 500 per account, for a day after the last update, and pushes it to FCM and
  UnifiedPush only. `starbridge run` posts the start, progress at most every 10 s,
  a heartbeat every minute and the exit; devices treat a run quiet for 3 minutes as
  lost. Its command's output goes through a pipe, not a terminal, so tools that
  print progress only to a terminal show none. The rules file is `rules.md` in the
  config directory. The web page and the Android Inbox show runs above the
  decisions, finished ones for 30 minutes; Android adds a notification per run,
  a Live Update on Android 16, whose end alerts once. Agents also wrap, unasked,
  any command that blocks the owner or needs them at the machine (e2e tests that
  take over the screen, keyboard or session, anything holding a device he uses);
  his rules add to that default, never replace it, and the reason stays required
  (owner). The plugin's SessionStart hook states that default in every session.
- 2026-10-05. Local agent (#68, part 1): `starbridge agent` is the same binary, one per machine.
  It keeps the one answer long-poll and the quota timer, and serves the CLI and sessions over
  HTTP on a unix socket (PROTOCOL.md, "Local agent API"). Answers stay in the CLI's state file,
  under its lock, so the agent and the CLI's own path share one store and the decision code.
  Every CLI command asks the agent first and talks to the server itself when none listens, or
  when the agent speaks another API revision (426). It never falls back once the agent has
  answered, so nothing posts twice. The agent runs only the CodexBar binary its own config
  names (`agent.json`, written by setup, or flags), never a path a client sends. No uid check
  on the socket's peer: neither Bun nor Node exposes `SO_PEERCRED`; the 0700 directory and 0600
  socket keep other users out.
- 2026-10-05. Images and links on a decision (#62): optional `images` (at
  most 4, PNG or JPEG, never SVG) and `links` (at most 4, HTTPS) in the
  signed body, so the server needs no change. `starbridge ask --image` scales
  each image down until the sealed decision fits the 256 KB per-decision cap;
  `--link` takes a URL, and the session's own links moved to
  `--session-link`. Android opens a claude.ai link in the Claude app
  (`com.anthropic.claude`) when that app takes it, else in the browser, and
  uses the first image as the notification's big picture.
- 2026-10-05. One question has one answer surface (owner, #62). A Claude
  artifact's button can message the agent (the Needs You page does), so a
  decision's links are context only, and a decision with `answerIn` is
  answered on that page: no options, a single "Answer in the artifact"
  button, and it closes when the agent runs `starbridge settle` (a `settled`
  notice, shared with permission prompts, #57) or at its default time. Both
  at once has no legitimate case, so the schema refuses `answerIn` beside
  options. `settle --outcome withdrawn` also closes a decision the agent no
  longer needs.
- 2026-10-05. Setup (#68, part 3): `setup`, `status` and `uninstall` live in `cli/src/setup/`.
  Setup pins CodexBar 0.72.0 and the SHA-256 of each CLI tarball. On Linux it takes the static
  musl build where the glibc one would not start: on musl, and where `libcurl.so.4` is missing,
  since the glibc build links it and a minimal Debian lacks it. A provider counts as working
  when `usage --provider X` returns windows. CodexBar exits 1 with the reason in the JSON row
  ("No available fetch strategy for codex."), so setup and the uploader read that row, not
  the exit code. The unit's `ExecStart` is the `starbridge` on the PATH when it is the running
  binary, since that path survives brew upgrades, and the unit gets setup's `PATH` for the
  `claude` and `codex` CodexBar calls. A rerun restarts the agent only when the unit or
  `agent.json` changed or it is not running. Setup turns on plugin auto-update through the
  marketplace's `extraKnownMarketplaces` entry in `~/.claude/settings.json`, which `claude
  plugin marketplace add` writes and no CLI flag sets. It stops a hand-written `starbridge
  quota push` unit before it starts the agent and keeps that unit's providers and interval. It
  also removes a copied mod (`~/.claude/mods/starbridge` and its `CLAUDE_CODE_PLUGIN_DIRS`
  entry), a copied skill and the CLAUDE.md rule. `uninstall` posts the revoke reminder first,
  while the keys work, and keeps the config directory unless asked.

- 2026-10-05. Permission prompts' protocol (#57): `ITEM_KINDS` in `packages/protocol` lists each
  sealed kind's signing role and the item it refers to, and the server and both clients derive
  their checks from it, so #58, #60 and #62 add kinds as table rows. Beyond the issue's spec:
  `settled` carries `to` (every sealed body names its recipients) and, for `outcome: "device"`,
  the device whose answer the machine applied, for the clients' log. It closes any item its
  machine posted (`itemId`), so #62 closes decisions with it (outcomes `elsewhere`,
  `withdrawn`) instead of a kind of its own; a second `settled` gets 409
  `already-settled`. The server, which cannot read `expiresAt`, refuses answers 10 minutes after
  the permission arrived. `GET /items` takes a comma-separated `kind` list and `open=1`; the
  machine's `checkPermissionAnswer` lives in the protocol package.
- 2026-10-05. Claude Code plugin (#68, part 2): the repo is the `starbridge` marketplace
  (`.claude-plugin/marketplace.json`) with two plugins. `starbridge` (`plugin/`) holds the skill
  and a `SessionStart` command hook that adds the rule "Whenever you need me to decide
  something, use the `starbridge` skill." as context, so no CLAUDE.md edit; it has no `bin/`.
  `starbridge-mod` (`mod/`) is the thin mod. `skill/` moved into `plugin/skills/`. The
  `/starbridge:setup` command waits for `starbridge setup` (part 3).

- 2026-10-05. Permission prompts on the machine (#57): Claude Code 2.1.289's `PermissionRequest`
  input carries no `tool_use_id` (probe log), so `hook settle` matches the call by the hash of
  its `tool_input` on `PostToolUse` and `PermissionDenied`, and settles all of the session's
  waiting prompts on `Stop` and `SessionEnd`. Only `addRules` allow rules and `addDirectories`
  suggestions are offered for "this session" and "always", and only when their rules fit the
  500-character rule text in full, since the scope applies every rule; a `setMode` suggestion (seen in the
  probe as `acceptEdits`) changes more than the call, so it stays at the keyboard. Without an
  agent the hook polls the server every 5 s, so a keyboard answer releases it within 5 s
  instead of at once. The `starbridge` plugin's `hooks.json` carries the hook entries
  (`PermissionRequest` with the 600 s timeout, the four settle events with 30 s).

- 2026-10-05. Release check (every feature end to end on an emulator, headless Chromium and a
  real Claude Code session with the plugins). Both clients follow one rule per quota state:
  "Headroom unused" only when the uploader raised the alert, "Ran out" once the predicted time
  passes, "Window reset" once the reset passes, and each card names its machine when the
  account has more than one active machine. A decision's context renders line breaks and code
  (inline and fenced); other Markdown, such as bold, shows as typed, and the skill says so
  rather than the clients growing a Markdown renderer. A deny with no typed message tells the
  agent the owner denied it, since Claude Code's default reads as a broken hook. Setup reports a
  failed step by the first line of its stderr.
- 2026-10-05. Landing page: `/` shows it to a signed-out browser that holds no device of the
  account it last signed in to; a browser with one gets the sign-in screen and its Inbox, as
  before. No route moved, so `/pair` links, the OAuth callback's redirect to `/`, the service
  worker's scope and Android deep links are unchanged. It reuses the Roborazzi screenshots,
  cropped to WebP in `web/public/landing`, and its sign-in button goes straight to GitHub;
  self-hosters reach the owner-token form from its footer.

- 2026-10-05. Uptime alert with no new accounts: `.github/workflows/uptime.yml` checks
  `/healthz` and `/healthz/backup` hourly (every 5 minutes once the repository is public), opens one issue labelled `outage` (GitHub
  emails the owner) and closes it once both pass. `/healthz/backup` answers 503 when the last
  good nightly backup is over 26 h old; it reads the age of a file `backup.sh` touches beside
  the database, and says nothing else.
- 2026-10-05. `https://starbridge.run/install.sh` is `cli/install.sh`, served by the web page as a
  route prerendered at build time, so each deploy serves the script of the revision it built.
  Caddy could not: it is recreated only when the Caddyfile changes, so a bind-mounted file would
  stay the previous release's. Each GitHub Release still carries a copy as an asset.
- 2026-10-05. Homebrew check, with the tap still private. The formula `release.yml` writes, built
  from locally built and signed release files, installs from the private tap in the
  `homebrew/brew` image and passes `brew test` (a token reached the tap for that run only). The
  tap's write deploy key is the one in `~/.config/starbridge/secrets`, and the workflow's pinned
  GitHub host key is current. The workflow itself was not dispatched: a run needs the owner's
  go-ahead. Only the documented install command assumes a public tap; the workflow pushes over
  SSH with its deploy key either way. Going public flips: (1) the tap, so `brew install
  T0mSIlver/starbridge/starbridge` clones it without credentials; (2) the main repo, since the
  formula, `install.sh`, `starbridge update` and the landing page's APK link (#107) all download
  from its GitHub Releases, and setup's plugin step (`claude plugin marketplace add
  T0mSIlver/starbridge`) and `starbridge update`'s plugin refresh clone the repo itself. None of
  them needs a change once it is public.

- 2026-10-05. Privacy policy and terms: plain pages at `/privacy` and `/terms`, linked from the
  web and Android sign-in screens; they also serve the Play Store listing. Each claim follows the
  code (stored columns in `server/src/db.ts`, retention in `server/src/limits.ts`, logs and
  backups in `deploy/`); the operator's legal entity, jurisdiction, rights statement, liability
  wording and account-deletion process stay marked TODO until the owner decides them.

- 2026-10-05. Platforms (owner). The web app ships first everywhere it can: installed to the home
  screen on iOS (Web Push works for home-screen web apps since iOS 16.4) and as an installed app
  on desktop browsers. No native iOS app until there is demand and a device to test on. A
  desktop app, if one comes, is Tauri over Electron so it reuses the web code; a Mac surface may
  instead live inside CodexBar's menu bar, upstream.
- 2026-10-05. Quota settings follow CodexBar (owner). Starbridge offers a curated set of
  CodexBar's own settings, with CodexBar's meaning, in its own clients and per device: the bar
  shows used or remaining (`usageBarsShowUsed`), reset times relative or absolute
  (`resetTimesShowAbsolute`), workday ticks on weekly bars (`weeklyProgressWorkDays`), warning
  thresholds per window (`quotaWarningThresholds`) and a pace warning
  (`predictivePaceWarningNotificationsEnabled`), and hiding or reordering providers. The warning
  settings are the quota notifications: off by default, enabled per provider (also from an
  alert card), at most one push per window per reset, on their own low-priority channel. Cost
  tracking, menu-bar-only settings and confetti stay out.
- 2026-10-05. Design v2 (owner, from mockup rounds 1–4,
  https://claude.ai/artifact/4Esy3goyohvLThcPVCKaEf, the source for every screen). Each surface
  has a job: the landing page shows the product (direction B, product showcase); the web app is
  a quiet, dense control surface for any browser (A), with the same structure but comfortable
  density on phones; Android is full Material 3 Expressive and feels native (C). Navigation: a
  web left rail (Inbox, Quotas, Settings) that becomes a bottom bar under 600 px; an Android
  bottom bar with the same three, Devices inside Settings. Inbox: one feed, with a remembered
  "Group by machine" option; answered items go to a collapsed, remembered History. Permission
  prompts and questions look different: a prompt shows a terminal tile, the exact command in
  mono, Allow/Deny and a waiting timer; a question shows its text as the title, then its options.
  A question shows "Working on other things" (neutral) or "Waiting for you" (amber, #122). One
  meta row of facts Starbridge knows (machine-kind icon and name, repo, time right-aligned);
  agent-written text is the content below it; details end with the session name, middle-truncated,
  and "Open in Claude" or "Open in Codex" (text, no logos). Quota bars fill in the provider's lab
  colour, replacing #72's dot; there are no status or provider dots, and the coloured status text
  carries the state. Amber never fills a bar: it only marks what needs the user. "Will run out"
  draws the projected overrun hatched in the lab colour with a red cap, and sorts first.
  Destructive actions are neutral on the row; only the confirm button in their dialog is red.
  Pairing is scan-first, with digit comparison as the "Can't scan?" fallback; account setup shows
  only on an empty account; self-hosting sits behind "Use your own server". Copy inside the UI is
  labels and states only. Icons: a custom set drawn to the mark on the web; Material Symbols
  Rounded tuned to Google Sans Flex on Android; a native iOS app, if any, would use SF Symbols.
- 2026-10-05. Design v2 on the web, inbox as built. One feed orders what holds an agent up
  first: permission prompts, then questions whose agent waits, then questions it works around,
  each oldest first; "Group by machine" keeps that order inside each machine and orders the
  machines by their most pressing item. History lists answered questions and the last 7 days of
  prompts, replacing the separate Prompts page. On phones every question shows its options on
  its row, as does every prompt with Allow and Deny. Deny sends no note to the agent, and a
  question with options has no free-text reply, both as in the mockups. A question's waiting
  state comes from #127's `waiting` items signed by the asking machine; the service worker
  shows a flip to waiting as the question's notification again, with "Waiting for you". The
  rail's Find filters the inbox by its words; the rail counts paired machines, since the page
  cannot tell which are connected.
- 2026-10-05. Quota settings and notifications, as built (#115). Settings live on each device
  (web `localStorage`, Android preferences) and sit on a Quota settings page opened from the
  Quotas screen: bars show used or remaining, reset times relative or as a clock time
  (CodexBar's: "14:30", "tomorrow 14:30", else the date), workdays on weekly bars (off, 4, 5 or
  7 from Monday; ticks evenly spaced, and the pace marker counts workdays in the device's zone,
  as CodexBar's `UsagePace.weekly`), workday ticks subtle, high contrast or hidden, and per
  provider show, notify and order. With no order set, alert cards come first as before. The
  default stays "used", where CodexBar defaults to remaining. The uploader adds a `low` alert at
  CodexBar's default thresholds (50% and 20% left) and the proposed pace rule: unused headroom
  1 hour before the reset for windows of a day or less, 1 day before for longer ones, at 30%
  unused. It records each alert it raised by window, kind and threshold with its reset in the
  CLI's state file, marks only a new one `notify`, and posts every other snapshot `quiet`
  (stored, not pushed), so FCM no longer wakes the phone every 5 minutes. A reset that moves by
  less than half its window is the same cycle, as in CodexBar. The thresholds are fixed rather
  than a setting, because the device's settings never reach the uploader. "Notify about" picks
  low, pace, or both, for the providers set to notify. Android shows them on a low-importance
  "Quotas" channel. The web page shows them while a Starbridge page is open, because quota
  snapshots still skip Web Push: a browser that opted out would get a push it shows nothing
  for, which Chrome answers with its own notification and Firefox and Safari count against the
  subscription.
- 2026-10-05. Waiting state, no default times (owner ruling on #122; protocol part). Agents
  never answer for the owner, so a decision has no default time, and its `default` is optional:
  machines keep sending its action only because clients from before this change require it, and
  no client shows it. A decision whose `answerIn` page goes unanswered stays open until the agent
  settles it. A new machine-signed kind, `waiting` (`decisionId`, `state`: `working` or
  `waiting`), says whether the agent is blocked on a decision. It is the first kind whose `re`
  closes nothing (`open` in `ITEM_KINDS`): the server refuses it once the decision is answered,
  keeps one per decision, re-posted under its id, and drops it with its decision. The machine
  posts every update `quiet` except a flip to `waiting`, which pushes once. Old clients list
  their kinds by name and skip unknown pushes, so they never see it. Two optional fields for the
  design (orchestrator): `source.machineKind` (`server`, `desktop`, `laptop`, `cloud`) and a
  decision's `agent` (`claude-code`, `codex`), as permissions have.
- 2026-10-05. Google Play and CI disk (#148): a release also attaches `starbridge-VERSION.aab`,
  signed with `release.jks` like the APK. Play App Signing keeps that key as the app signing key
  and accepts it as the upload key too (#59's handoff), so Play builds and GitHub APKs share one
  signature. The three self-hosted runners share one Gradle home,
  `~/.local/opt/gh-runners/gradle`, which Gradle locks for concurrent builds; `android.yml`
  turns setup-gradle's cache off on them (`cache-disabled` when `vars.RUNNER` is set), since its
  restore overwrote files a concurrent job was reading (#142). This freed 3.6 GB.

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
- Pairing without typing (2026-10-05, #66): a device signed in to the same
  account joins by digits, a 6-digit short authentication string with a
  commitment (ZRTP, Matrix SAS) that both screens show; or a phone scans a QR
  code an existing device shows; or the owner opens the link `starbridge pair`
  prints. The 24-character code stays as the fallback. Design and vectors in
  PROTOCOL.md, "Joining by digits".
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
- 2026-10-05: setup research (#68). Claude Code 2.1.289 plugins can ship
  skills, command hooks, `bin/`, `userConfig` and mods (a plugin whose
  `hooks/hooks.json` lists `modules`); the owner's localvoxtral marketplace
  already installs a mod at user scope. A plugin-root `CLAUDE.md` is not
  loaded. `claude plugin marketplace add` and `claude plugin install
  --scope user` run unprompted from a script for git sources. CodexBar:
  macOS `brew install --cask codexbar` with the CLI inside the app; release
  tarballs for macOS and Linux (glibc and musl); a brew tap and AUR on
  Linux; browser cookie import is macOS-only; `codexbar config providers
  --format json` lists providers but not whether they are signed in, which
  only `usage --provider X` shows; `codexbar --version` printed `unknown` on
  the dev box.
- 2026-10-05: permission hook probes (#57), Claude Code 2.1.289 in a
  terminal (tmux, Haiku), a throwaway `PermissionRequest` command hook that
  waits, then allows. The dialog shows while the hook waits, and the hook's
  answer resolves it. Under `--dangerously-skip-permissions` an `ask` rule's
  prompt still reaches the hook (`permission_mode: "bypassPermissions"`),
  although the docs say the hook does not fire in that mode. When the
  keyboard picks Yes first, the hook gets no signal and its answer is
  dropped; Esc or No interrupts the turn and sends the hook SIGTERM within
  0.1 s. `permission_suggestions` holds SDK `PermissionUpdate` objects (here
  `addDirectories`). Codex 0.160.0 asks the user to trust any new or changed
  hook at launch; its race test waits for the Codex limit to reset.
- 2026-10-05: specs for #58, #60 and #62 revised to answer the owner's
  questions (cards on the Needs You page). Mod API, 2.1.289: a `tool.call`
  hook sees each Bash call start and end in-process (`await next(e)` costs
  no hook budget), but no event carries a tool's output while it runs;
  `process.spawn` streams only the mod's own children. So #60 times agent
  commands from the mod with no wrapper, and reads progress from output only
  under `starbridge run`.
- 2026-10-05: image budget (#62). Each box carries the whole body, so an
  image byte costs about (4/3)² bytes per device: base64url in the body, then
  base64url of the sealed envelope. With the 256 KB cap, the images of one
  decision get about 140 KB raw with one device, 70 KB with two and 47 KB
  with three. The CLI's pure-JS JPEG encoder fits a 1233x2673 phone screenshot
  in 72 KB at 515x1117 and in 20 KB at 272x589, in under 0.1 s. A shared
  ciphertext encrypted once with a key in each box would free the per-device
  cost, at the price of a new item field and storage on the server; not
  needed while the owner pairs two or three devices.
- 2026-10-05: the installed web app (#116), checked with Playwright 1.63's
  WebKit 26.6 and Chromium 153. WebKit stores an X25519 `CryptoKey` in
  IndexedDB but reads the whole record back as null; Ed25519 and AES keys
  round-trip. The page then lost its device on every load, so key generation
  now writes the keys and reads them back once, and falls back to libsodium
  keys when they don't return. Whether Safari on iOS has the same bug is an
  owner check on #116. iOS gives Web Push only to Home Screen apps, which keep
  their own storage, so a Safari tab shows the Add to Home Screen step instead
  of the push button. Chrome prefixes the app name to an installed window's
  title unless the title starts with it, so titles read "Starbridge · Quotas".
- 2026-10-05: hooks and mods in Remote Control and cloud sessions (#57),
  Claude Code 2.1.289. The Remote Control probe ran a second server
  (`claude remote-control --spawn same-dir --permission-mode auto`) on the
  owner's login, in a scratch folder whose `.claude/settings.json` held
  logging hooks. A throwaway `CLAUDE_CONFIG_DIR` was not possible, because
  the auto-mode classifier refused copying the login into it. The server
  starts each session as a child `claude --print --sdk-url …
  --input-format stream-json --permission-mode auto`. The child's debug log
  shows the user's plugin (`localvoxtral-remote`) and mods
  (`orchestrator-cache` from `CLAUDE_CODE_PLUGIN_DIRS` in user settings,
  `prompt-cache-control` from `~/.claude/skills`) loading, and the project
  hooks fired. Claude Code ignores `CLAUDE_CODE_PLUGIN_DIRS` in project
  settings and logs a warning, so a mod loads only from user or managed
  settings or an installed plugin. An `ask` rule still prompts in auto mode.
  For it the `PermissionRequest` hook fired, with `permission_mode: "auto"`
  and no `tool_use_id` as in the terminal, and the prompt also went to the
  Claude app. So the earlier reading that the hook does not fire under `-p`
  does not hold for a `--print` child driven over `--sdk-url`. Classifier blocks were seen in the
  cloud probe below, also in auto mode. Each blocked call fired `PreToolUse`
  then `PermissionDenied`, and no `PermissionRequest`. The hooks docs say
  the same: "It doesn't fire in auto mode, where Claude Code denies
  disallowed calls without prompting." So in auto mode Starbridge sees only
  the calls that still prompt. Those are `ask` rules and, per the docs, every
  call once the classifier pauses after 3 blocks in a row or 20 in total. A
  block reaches Starbridge only as a `PermissionDenied` after the fact, which
  it could show as a notice but cannot answer.
  The cloud probe was one real session in the Default environment, on a
  throwaway branch (since deleted) whose `.claude/settings.json` held
  logging hooks, an `ask` rule and `enabledPlugins` for the starbridge
  marketplace. It ran as root in `/home/user/starbridge` with
  `CLAUDE_CODE_REMOTE=true`. The repo's `SessionStart`, `PreToolUse` and
  `PermissionDenied` hooks fired. `~/.claude/plugins/installed_plugins.json`
  was empty, so the repo's plugins and their mods were not installed, as
  the cloud-environments docs say. Nothing from the owner's `~/.claude` is
  there. The classifier blocked listing environment variable names and a
  curl to `starbridge.run/install.sh`. So in a cloud session Starbridge can
  only be repo hooks that call a `starbridge` binary the environment
  installs. Per the docs, a setup script runs as root before Claude Code
  starts and its result is cached for about 7 days. Reaching
  `starbridge.run` needs network access Full, or Custom with that host.
  Environment variables are plain `.env` text that "anyone who uses the
  environment can read", and the agent can read them too, so a machine key
  there is not secret. Setup scripts get no secret store; the Pro and Max
  "API credentials" proxy covers model API keys only. To give a cloud
  environment a machine, the owner opens claude.ai/code, clicks the
  environment name above the message box, then Cloud, then "Add cloud
  environment", and sets network access to Custom with `starbridge.run`
  plus the defaults, the machine key as an environment variable, and a
  setup script that runs the install script and pairs. Whether cloud
  sessions should get a machine at all is open, since the agent can read
  its key.
