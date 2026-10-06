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
checkout, upstream `60c1adbce` (2026-10-04):

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
  three drafted on the options page,
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
  (`@scure/bip39`, audited, MIT); 12 for accounts made since 2026-10-05, and a recovery key
  instead of words since 2026-10-06 (below).

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
  only deploy a commit that is on GitHub's main (since 2026-10-06, main's head or one newer
  than the deployed one): the box fetches that commit itself with a read-only GitHub deploy
  key. `deploy/deploy.sh` stays for rollbacks and other refs. The
  `cli-v*` workflow folded into the release one.
- 2026-10-05. Per-account bounds before hosted signups (#65): every route that stores
  something has a cap or a retention rule, and the writes that grow it a rate limit, sized for an
  orchestrator with 10 sessions asking a few hundred decisions a day. Answered decisions and
  their answers are kept 7 days, unanswered decisions and quota snapshots 30; 10000 stored
  decisions and 128 MB per account; directories end at 200 entries, which is about 100 add and
  revoke pairs; an account that reaches it needs the operator to reset it (since 2026-10-06,
  the cap stops adds only: see the #260 entry). The numbers live in
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
- 2026-10-05. Docs at `/docs` on the web page (#211), not a Zensical site: the pages listed in
  `web/src/lib/docs.ts` are Markdown files of the repository (`docs/index.md`, `cli/README.md`,
  `docs/tell-your-agents.md`, `server/README.md`), rendered with `marked` at build time. Links
  between them become `/docs` links; other relative links go to GitHub. The web page, the landing
  page and Android link there, since GitHub links 404 while the repository is private. The
  overview and the landing page say Starbridge works best with Claude Code and supports Codex.
- 2026-10-05. The landing page leads with questions (#210): its lead, feature list and browser
  shot put questions, images and runs first and permission prompts last, since they are off by
  default. The browser shot is `/sample-hero` (development only): the sample inbox without its
  permission prompt or lost run, the question with images open. The footer says that only the
  owner's own devices can read questions, answers and quotas.
- 2026-10-05. A browser whose device was revoked gets the landing page, not sign-in (#209).
  Revoking a device keeps its sessions' hashes until they would have expired, and the server
  answers them 401 `revoked`; the browser then forgets the device and is a visitor again.

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
- 2026-10-05. Legal pages filled in (owner): the operator is Tom Vaucourt as a non-professional
  individual in France, with the host's address (Hetzner) instead of his own, as LCEN art. 6
  allows. Current features stay free, 60 days' notice before any price; 30 days' notice before a
  shutdown; suspension appeals to abuse@ within 30 days, answered within 14; French law and
  courts, consumers keep their own; no fixed log age (logs hold no IPs and rotate by size);
  account deletion confirmed by a code in a public gist on the GitHub account, done within 30
  days; GDPR rights with CNIL as the authority.

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
  the source for every screen). Each surface
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
- 2026-10-05. Design v2 on the web: settings, first run and landing page, as built. Settings is one
  page: quota display and warnings, providers (drag or arrow keys to reorder, Notify, Show),
  devices with Revoke behind a dialog, Colours (System, Light, Dark, applied before the first
  paint), and a link to "How to tell your agents". Providers get a Notify switch, not the
  mockup's "Warn at 90%" field, since #115 fixed the thresholds; device rows show the date
  added, since the page has no last-seen data. Add a device opens on a QR code for the new
  phone; the `starbridge pair` code field sits below it. A browser joining an account shows its
  own QR code (a `/pair#code` link that a signed-in device opens), with "Can't scan? Compare
  digits" and the recovery key as fallbacks. The landing page's browser shot is the real app at
  `/sample`; its phone shots are the app's Roborazzi shots (`inbox-landing`, an inbox with no
  prompt, and `sheet-pick`, a question with two images, #210), with the round 4 mockup's lock
  screen, which Roborazzi cannot render.
- 2026-10-05. Answer buttons on inbox rows, web (#138). Settings, Inbox: "Answer buttons on
  questions", Always (the default), When the agent waits, or Never, remembered on the device. It
  applies to question rows on a phone width; wide screens never carry them, since the open
  question sits beside the list. Permission prompts keep Allow and Deny on their rows, since
  their agent always waits.
- 2026-10-05. A question's state and its answer buttons, after the launch test (#166, #181;
  agreed between the web and Android sessions). "Working on other things" read as the agent's
  words, so a question its agent works around shows no state line at all; one its agent waits on
  shows "Waiting for you 1:12" in amber, its icon on the text's centre line, on the card or row,
  in the detail and in the notification, where it sits outside the agent's words (Android: in the
  header after the machine and repo). Permission prompts keep the same tag. Answer buttons follow
  only the setting, on both clients: every question with options shows them on its card or phone
  row under Always, the ones whose agent waits under When the agent waits, none under Never.
  Images and long labels no longer hide them; more than two options, or a label over 18
  characters, stack. A question answered on another page (`answerIn`) or in free text has no
  buttons, and opens its detail.
- 2026-10-05. Images on Android (#170). A card crops its images to the card's width from the
  top, at most 160 dp tall, so a phone screenshot no longer shows as a thumbnail in an empty band;
  the sheet shows each in its own shape. A tap opens a full-screen viewer on black: pinch or
  double-tap to zoom, drag to pan, swipe between images, decoded up to 4096 px. Decisions saved
  by an app from before images (#62) kept bodies without them, so the app reads its open
  decisions again from the server once. The notification puts the agent's Markdown code in mono,
  without backticks.
- 2026-10-05. Android notifications after the launch test (#182, #183, #184). A permission
  prompt's notification shows only its command, in mono; the agent's description stays in the
  app. Questions and prompts turn off Android's own contextual chips ("Open link"), so the only
  buttons are the answers. With sensitive content hidden, the lock screen shows the public
  version, so it carries the same buttons: Deny and a question's options answer from there,
  Allow asks for the unlock first, as decided for #57; the question and the command stay hidden.
  Tapping a prompt's notification opens that prompt's sheet, as a question's opens its own.
- 2026-10-05. Runs with no news (#190). A run that reports no progress shows an indeterminate
  bar while it runs. A lost run (no update for 3 minutes) shows no time in its meta row: a run
  killed before its first heartbeat has its last news at its start, so the only duration known
  would read "0 s". Its line "Lost, no news for 3 min 37 s" ticks each second, and it shows no
  progress (the word "Lost" since #249).
- 2026-10-05. Android notification channels and order (#196). The channels sit in two groups,
  "Needs you" (Decisions, Permission prompts, Join requests) and "Activity" (Runs, Quotas), instead
  of Android's "Other". Each notification carries a sort key, questions and prompts first, then
  join requests, runs and quotas, because Android orders an app's bundled notifications by sort
  key before importance. Not yet checked on a device.
- 2026-10-05. Links on questions, Android (#171, the web session's rule): under "Attached by the
  agent", each chip reads "Open" and the link's title, else its label, with an open-outside icon.
  A Claude artifact, as a link or as `answerIn`, opens in the browser, since the Claude app shows
  it only in its in-app browser; a session link still opens in the Claude app.
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
- 2026-10-05. Waiting state on the machine (#122) and permission prompts off by default (#124).
  `starbridge waiting <id>` and `starbridge working <id>` post a decision's state; `ask
  --waiting` posts it already waiting, and `wait <id>` marks it waiting before it blocks. The CLI keeps each decision's waiting id
  and last state, posts nothing when the state is unchanged, and refuses once the decision is
  answered. The default-time machinery is gone: no `--default-at` (accepted and ignored, with a
  warning), no `default` session event, no notice line, and `wait`
  ends only at `--timeout`. `--default` is optional; without it the CLI sends "Waits for your
  answer" for older clients (since #352, it is always sent and `--default` is ignored). Decisions carry `agent` (`--agent`, else `claude-code` when Claude
  Code runs the CLI, which sets `CLAUDECODE=1`), and every source carries `machineKind`:
  `pair` and `setup` guess it (cloud session or codespace, a battery, Linux with no display,
  else desktop) and `starbridge config machine-kind` corrects it. `starbridge config
  permissions on|off` replaces `starbridge permissions enable|disable`, so one command holds the
  machine's settings; setup asks, default no, and says the Claude app already shows prompts
  for Remote Control sessions.
- 2026-10-05. Release keys backed up off the dev box (owner): `release.jks`, its password file
  and `minisign.key` are in an AES-256 encrypted disk image, `starbridge-release-keys.dmg`, in the
  owner's iCloud Drive and Google Drive; its passphrase is in his Google Password Manager under
  `starbridge.run`, user `release-keys-dmg`. Google Play: a personal developer account, developer
  name `T0mSIlver`, identity check pending; production needs a 14-day closed test with 12 testers.

- 2026-10-05. Usage counts (#140, owner ruling: learn how Starbridge is used without client
  telemetry or anything new collected). The server counts requests it handles anyway
  (`server/src/usage.ts`): during a day, `usage_events` holds one row per event, with the
  account or member id only where a count is of distinct ones (active accounts, machines, and
  devices split by sign-in: the cookie is the web page, a bearer token the Android app). Each
  hour, and at start, every finished day is folded into `usage_days` (day, metric, value: counts,
  and p50 and p90 of seconds to answer) and its events are deleted, so no per-user row outlives
  its day. Metrics: `active.*`, `items.<kind>` per post, `answered.<kind>.seconds` and
  `answered.by.<client>` per device answer, `push.<type>.<outcome>` per push, `relay.<type>.<outcome>` per push relayed for another server, and at the close
  `total.*`, `new.accounts` and `total.push-targets.<type>`. Read access is a CLI, not an admin
  page: `bun server.js usage [days]` inside the server container on the VPS
  (`deploy/README.md`). It is the simpler of the two, adds no route, and needs no owner flag
  (the hosted owner signs in through GitHub like everyone, and `accounts.owner` marks only the
  self-hosted owner-token account); whoever can open the database reads it. `/privacy` lists the
  counts in their own section.
- 2026-10-05. Page analytics (owner ruling on #141, as built). Umami 3.4.0 with Postgres 18 runs
  in the deploy's Compose project, on a network of its own. Only the landing page, `/privacy`
  and `/terms` load its tracker, from `/stats/script.js` on starbridge.run; Caddy passes that
  file and `/stats/api/send` to Umami and nothing else, so no DNS record is needed. Auto-tracking
  is off and each public page records its own view, because the tracker would otherwise follow
  the app's client-side navigation after an owner-token sign-in from the landing page. Copying
  an install command records `copy-install` with the method (Script, Homebrew, npm). No cookie,
  no browser storage, no stored IP address: the visitor hash's salt changes daily
  (`SALT_ROTATION=day`), Do Not Track is honoured, and `/privacy` lists what Umami records, so
  there is no consent banner. The dashboard listens on the VPS's `127.0.0.1:3001` only; the owner
  reaches it through an SSH tunnel. The first deploy makes the database password and Umami's
  secret on the box (`deploy/host/umami-env.sh`); `deploy/umami-setup.sh` then replaces the
  default admin password and creates the website under the id the pages send, which is fixed in
  `web/src/lib/analytics.ts`. The nightly backup also dumps Umami's database (`pg_dump -Fc`, 14
  days). Umami drops headless browsers' hits as bots, so a Playwright check needs a desktop user
  agent.

- 2026-10-05. Agents reach the owner through Starbridge (#121, owner). The skill and the
  SessionStart rule say Starbridge is how an agent reaches its user: a card for a decision that is
  theirs, a card before ending a turn on work that waits on them (a PR to review, a failure only
  they can fix), `starbridge run` around commands that block them; everything else the agent
  decides, and it asks in the terminal only when `starbridge` fails. A card answers cold: a
  question its options answer, two to five lines of context saying what each option changes,
  links and images only when they help decide, one question per card. Agents never answer for
  the owner: no default to apply when nobody answers; a blocked agent works on something else,
  builds both options when cheap and asks which to keep, or waits (#127 made `default` optional in
  the protocol, and #352 dropped `ask --default`). A `PreToolUse` hook on `AskUserQuestion`
  (`starbridge hook ask-user`) turns the question away towards `starbridge ask`, unless the
  machine is unpaired or the server does not answer within 3 s. The skill no longer covers
  permission prompts (#124). `evals/skill` checks all this with real Claude Code and Codex
  sessions; under the owner's home, Claude Code loads `~/.claude/CLAUDE.md` as an ancestor
  folder's even with `CLAUDE_CONFIG_DIR` set, so eval sessions run under `/tmp`.

- 2026-10-05. No Starbridge rules file (#126, owner). The SessionStart hook adds only its two fixed
  rules; `rules.md` is gone. Users tell agents what else to ask or report in the agents' own
  instruction files, and `docs/tell-your-agents.md` says where, with lines to copy. Personal
  files over a repo's shared ones, checked by real runs (Claude Code 2.1.289, Codex CLI 0.160.0,
  pi 0.87.1): globally `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`;
  per repo, Claude Code's `CLAUDE.local.md` loads beside the shared `CLAUDE.md`, while Codex's
  and pi's `AGENTS.override.md` replaces the repo's `AGENTS.md`, so it only suits repos without
  one.

- 2026-10-05. 12 recovery words for new accounts (owner ruling on #157). The recovery seed is now
  16 bytes, shown as 12 BIP-39 words, instead of 32 bytes as 24. 128 bits of entropy is what
  Ed25519 itself offers (about 2^126 work to break a key), so 24 words added length without
  adding security. Someone holding the recovery public key, the server included, would have to
  try 2^128 seeds offline, or 2^108 per account across a million accounts. The seed is random,
  not chosen by a person, so it needs no slow key derivation such as Argon2; BLAKE2b-256 of
  "starbridge/v1/recovery-seed", NUL, the seed, stretches it to the 32 bytes Ed25519 takes, as
  `pairingKey` does for the pairing secret. Accounts made earlier keep their 24 words, whose
  32-byte seed stays the Ed25519 seed; the word count tells the two apart, and nothing on the
  server changes. Fewer words was rejected: one word carries 11 bits, and 9 words (99 bits) is
  no BIP-39 length. The entry says to separate words with spaces, and accepts anything that is
  not a letter as a separator (dashes, commas, line breaks, numbering); it names the first word
  that is not on the list, and a failed checksum (a wrong list word, or two swapped) says to
  check each word and the order.

- 2026-10-05. Quota order, one rule on both clients (#159, #162, owner). Hidden providers drop out;
  the rest go by provider in the order set in Quota settings (providers not in it follow in the
  uploader's order), each provider's windows in the uploader's order. A "Running out first"
  setting, on by default as Design v2 chose, then moves windows that will run out or ran out,
  and have not reset, above the others, in that same order. Off, the order set holds for every
  window. Alert windows no longer lead when no order is set: the old fallback is why the phone
  and the browser sorted differently. Order stays per device. Notify moves off Android's cards
  to Settings, Providers, as on the web (#163): a bell beside each provider's Show switch,
  so every quota card has the same height and the control sits where the other per-provider
  settings are.
- 2026-10-05. Full-size images on questions (#170). The owner's phone screenshot (1236×2676 PNG,
  171 KB) arrived as a ~515 px JPEG and looked pixelated: the 256 KB cap held every device's box
  together, so three devices left about 47 KB per image. A decision's boxes may now hold 2 MB
  together and an image's base64url 512 KB (both clients' schemas), and the CLI keeps a file as
  is up to a 3000 px edge, so that screenshot reaches six devices unchanged and the clients'
  full-screen viewers can zoom into real pixels. The request body limit rises to 3 MB to match.
  WebP was not the fix: the pure-JS encoders save a third at best, and the cap was the cause. A
  self-hosted server older than this refuses a new CLI's larger decisions with 413 `too-large`
  until it updates.

- 2026-10-05. Clock setting (#161, owner). Settings, Clock, "Time format": System (the default),
  12-hour or 24-hour, per device. System follows the device: Android's
  `DateFormat.is24HourFormat`, the browser's language on the web. Android also writes dates in
  the phone's language ("Oct 7" in English, "7 oct." in French) from Android's own patterns, where
  it used fixed English ones; words such as "tomorrow" stay English, as the rest of the UI.
- 2026-10-05. Links on questions (owner, launch test #171: "there should be a more explicit 'the
  agent pushed this artifact for you to see'"). A link on a question is something the agent wants
  the owner to see before answering: a page it built (a Claude artifact), a PR, a doc. It never
  answers the question; that is `answerIn`'s job. Both clients show links under "Attached by the
  agent", each as "Open" and its title (else "Claude artifact", else host and path) with an
  open-outside icon, and the skill gives each link a `title` naming what it shows. A claude.ai
  link opens in the browser, where the owner is signed in, rather than in the Claude app, which
  shows artifacts only in its in-app browser.
- 2026-10-05. Questions on the web after the launch test (#165, #170, #172, #173, #179). Images open
  in a full-screen viewer in the same tab (wheel or pinch to zoom, drag to pan, double click for
  real pixels, arrow keys between images), not a new tab. On a wide screen the list and Quota
  windows panes resize by dragging their edge or with the arrow keys on it, remembered on the
  device (double click resets); phones have no handles. The open question's content is centred
  in its pane up to 720 px, so a short question leaves even margins instead of one wide band. The
  session name is cut in the middle only when its line runs out of room. Settings, Inbox:
  "Sound for new questions" (off by default) chimes once per new question, prompt or flip to
  waiting while a Starbridge page is open, once across the browser's tabs. Nothing plays with no
  page open: a service worker cannot play audio and browsers honour no sound option on Web Push,
  so sound without a page is the OS's notification setting (macOS: Notifications, the browser,
  "Play sound for notifications"). Browsers start audio only after a tap or key on the page, so
  a page opened and never touched stays silent.
- 2026-10-05. Runs on the web (#188, #190). Runs still skip Web Push, since a push that shows no
  notification costs the browser subscription, so the page polls them every 2 s while one runs and
  the page is visible, and every 10 s otherwise; that keeps it within a few seconds of the phone,
  which gets each update by push. A lost run shows no elapsed time in its corner: its last news
  may predate most of its life, so the time would read as 0.

- 2026-10-05. Quota windows grouped by provider (#160, layout C of
  the owner's mockups). The provider's name heads one card (Android)
  or one block (web, the landing page included), with the machine beside it when several upload;
  its windows follow as rows that name only the window. Groups come in the order of their first
  window under "Quota order", so a provider with a window running out leads, and its running-out
  window leads inside it. The provider shows once, so skimming the list reads provider names only.

- 2026-10-05. A device sees quotas as soon as it joins, and pulling to refresh gets fresh ones
  (#158). A snapshot is sealed to the devices in the directory when it is posted, so a device that
  joined later read nothing until the next upload, up to 5 minutes. Fixed at the source: every
  directory append ends the machines' answer long-polls, whose replies now carry the directory's
  length, and the agent posts a fresh snapshot (CodexBar takes about 4 s) once its re-read
  directory holds a new device. Pull to refresh on Android's Quotas calls `POST /quota/ask`, which
  wakes the machines the same way and holds until each has posted, then refetches. Asks are
  rate-limited to 6 a minute per account, since each runs CodexBar on every machine. The web page
  has no refresh gesture and gets none; it polls quotas every minute, and every 3 s for its first
  30 s while it holds none, so a browser that just joined shows the re-upload within seconds.
- 2026-10-05. `starbridge pair` pairs with https://starbridge.run unless `--server` or
  `STARBRIDGE_SERVER` names a self-hosted server (#154), as `setup` already did.

- 2026-10-06. A recovery key, not words (owner ruling on #199, replaces the words of #157). Chrome
  flagged starbridge.run as a dangerous site: a new site that shows 12 BIP-39 words and later asks
  for them back is what seed-phrase phishing looks like. New accounts get the same 16-byte seed
  as a recovery key: the seed and a 12-bit check, 28 Crockford base32 characters in seven groups
  of four, read in any case, with or without dashes, with Crockford's look-alikes. The check
  catches all but 1 in 4,096 typos, as BIP-39's 4 bits caught all but 1 in 16 for 12 words; a
  character outside the alphabet is named where it stands. Strength and derivation are those of
  the 12-word entry above: 128 bits, stretched to the Ed25519 seed by BLAKE2b-256. Accounts with
  24 or 12 words keep recovering with them: the entry tells words from a key by their letter runs.
  No page says "seed", "phrase" or asks for words; the clients only show keys. #199 closes once
  this is deployed and Chrome no longer warns.
- 2026-10-05. The `AskUserQuestion` hook answers instead of denying (#200). Claude Code 2.1.289
  shows every `PreToolUse` deny as a red "hook error", which reads as Starbridge failing. The
  hook now allows the call with `updatedInput.answers`, one answer per question saying to ask
  through `starbridge ask`; Claude Code shows that as an answered question and opens no dialog
  (checked in a real session). Input it cannot read is still denied.
- 2026-10-05. A question asked already waiting notifies as waiting (#202). `ask --waiting`
  used to push the decision, which carries no state, then post its `waiting` item quietly, so
  the phone's notification said "Working on other things" while the app said "Waiting for
  you". Now the decision goes quietly and the `waiting` item pushes; Android fetches a decision
  it has not seen when its waiting state arrives, as the web page's service worker already did.
  An app older than this change shows no notification for such a question until it syncs.
- 2026-10-05. How an answer reaches each agent (#203). Only the Claude Code mod brought an answer
  back after a turn ended, and the skill told every agent never to block on `starbridge wait`, so
  Codex never got its answers. Research on Codex CLI 0.160 (issue comment): its TUI runs sessions
  in a shared app-server daemon by default, and `codex queue --thread <id> --message <text>` adds
  a user message to one; checked live, an idle session starts a turn with it at once and a busy
  one runs it next as its own turn, as with the mod. Hooks (`Stop` blocking with the answer), an
  MCP tool that waits, and `notify` either block the turn as `wait` does or bring nothing back.
  So `ask` records a Codex session (`CODEX_THREAD_ID`, its `CODEX_HOME` and `codex`), and the
  machine's agent queues each answer into it, confirming the answer only when `codex queue`
  succeeds; on failure it tries again a minute later, 30 times at most. `ask` prints how
  the answer comes back: as a prompt (Claude Code; Codex when the agent runs and the session's
  daemon socket accepts a connection) or not, and then the skill has the agent wait with
  `starbridge wait <id> --timeout 5m` before it ends its turn (`codex exec`, pi, no agent). The
  skill follows that line instead of naming agents. `evals/skill` runs `codex exec`, so it
  checks the wait path: it answers a Codex card on the server during the turn, as the owner
  would.
- 2026-10-06. Agents clients do not know (orchestrator, for #232). `Agent` gains `pi`, and items
  carry `agent` as any name of up to 40 lowercase letters, digits and dashes (`AgentName`):
  clients show an agent they do not know as none, with no "Open in" link, instead of refusing
  the decision or prompt. So a future harness never makes items unreadable to older clients.
  Clients released before this change still refuse an agent outside `claude-code | codex`.
- 2026-10-06. Pi is the third harness (#232; research on the issue, Pi 0.87.1; checked again on
  Pi 1.0.4, whose changelog since 0.87.1 changes none of the API it uses). A Pi extension
  can call `pi.sendUserMessage(text, { deliverAs: "followUp" })` at any time: an idle session
  starts a turn with it, a busy one runs it once the agent finishes, as the mod and `codex
  queue` do. So the Pi extension (`mod/pi/starbridge.ts`) runs the mod's own answer loop
  (`agent.ts`, `poller.ts`, `switch.ts`, which never depended on Claude Code), through the
  machine's agent or the CLI, and submits each answer that way. It runs only where Pi has a UI
  (TUI and RPC), since `pi -p` ends after one prompt, and while it runs it sets
  `STARBRIDGE_PI_ANSWERS` to the session's id for its commands. It also appends `plugin/hooks/rule.md`, the
  rule the `SessionStart` hook adds in Claude Code, to Pi's system prompt. The repository's root
  `package.json` is a Pi package (that extension and `plugin/skills`): `pi install
  git:github.com/T0mSIlver/starbridge`. `ask` detects Pi from `PI_SESSION_ID`, which Pi's bash
  tool gives every command, after Claude Code and Codex. It records that session id and takes
  the card's session title from the name in `PI_SESSION_FILE`. It says the answer comes back as
  a prompt only when `STARBRIDGE_PI_ANSWERS` is that session's id (a `pi -p` started from the
  session's shell inherits it), else it prints the `starbridge wait` line. A
  decision from Pi carries `agent: "pi"` (the entry above); a client released before it refuses
  such a decision. Pi has no built-in AskUserQuestion and no permission prompts; both come from third-party
  extensions. Starbridge does not intercept ask tools (blocking a tool by name would tie it to
  one extension); the skill tells every agent to avoid any tool that asks the user. Permission
  prompts go through pi-permission-system (the entry above).
  Checked with a real Pi 0.87.1 TUI (GLM 5.3) in a throwaway HOME, the local server, the built
  web page in Firefox and `starbridge agent`: Pi posted the card, the web page answered "French",
  and Pi wrote the file. Without the agent, an answer given during a `sleep 40` ran once that
  turn ended. Both again on Pi 1.0.4 (fullscreen TUI, its new default), and the agent path again
  on 0.87.1, with the code as merged.
- 2026-10-06. Pi's permission prompts (owner, #232), through pi-permission-system (33.1.1 for Pi
  0.87, 39.1.0 for Pi 1.0, same chain API), which most Pi users run. Its authorizer chain asks each link the owner names in its `config.json`
  (`authorizerChain`) before its own dialog, whenever a rule says `ask`; a link answers allow,
  deny with a reason, or defer. The Pi extension registers the link `starbridge` through the
  service pi-permission-system publishes on `globalThis` per session, since Pi packages share no
  modules. The link runs `starbridge hook permission --agent pi`, the command Claude Code's hook
  runs, with the same input shape: Pi's tool name and its command or path, and no suggestions,
  since the chain never lets a link allow for the session, so devices offer Allow (this call)
  and Deny. Nothing reaches the devices until the owner both names the link and turns on
  `starbridge config permissions`, as for Claude Code. Turning it on (`config permissions on`,
  or setup) offers on a terminal to add the link to `authorizerChain`, keeping the rest of the
  file; without a terminal it prints the line to add and writes nothing. The link defers, and Pi shows its own
  dialog, while Starbridge is off, the machine is unpaired, the server does not answer, or after
  570 s. The chain runs before pi-permission-system's dialog, so while the devices have the
  prompt Pi shows "Answer here": choosing it stops the CLI, which settles the prompt on the
  devices as answered at the keyboard, and the link defers to the dialog. The dialog appears
  only after 1 s, so a CLI that defers at once shows nothing. Pi strands a dialog that another
  opens over it, so overlapping asks show theirs one at a time, each holding the screen until
  pi-permission-system announces its decision (`permissions:decision`), since after "Answer
  here" its own dialog follows (at most 10 min). A session that ends stops its
  links' CLIs, which settles their prompts on the devices. Checked with a real Pi TUI and
  pi-permission-system: `touch approved.txt` allowed from the web page; `touch second.txt`
  taken back with "Answer here" and denied in Pi's dialog, settled `keyboard` on the devices;
  with permissions off, Pi's dialog came up at once and nothing was posted. Again on Pi 1.0.4
  with pi-permission-system 39.1.0: allowed from the web page, taken back and denied, and two
  parallel asks, one allowed from the web page and the other, whose dialog came next, at the
  keyboard; `config permissions on` added the link to the chain on a terminal.
- 2026-10-06. Setup installs Starbridge in every agent it finds (#239). After the Claude Code
  plugins, it offers the skill to Codex when `codex` is on the PATH, written to
  `$CODEX_HOME/skills/starbridge/SKILL.md` (default `~/.codex`) from the copy the CLI carries,
  so it needs no download from the repository and matches the CLI's version; a rerun offers to
  update a skill that differs. It offers the Starbridge Pi package when `pi` is on the PATH
  (`pi install git:github.com/T0mSIlver/starbridge`), unless Pi's settings list it already.
  Each asks first, `--yes` takes the defaults (install), and `--no-plugin` skips all three.
  `status` reports both, and `uninstall` removes the skill folder (only when it holds the
  Starbridge skill) and the Pi package. The docs drop the curl step for Codex.
- 2026-10-06. A deploy goes unnoticed in the clients (#250). The web page and the Android app retry
  a 502 or 503, which Caddy sends while the server restarts, and a refused connection, quietly for
  20 s with a backoff from 250 ms to 4 s, before they show an error. A write retries only on those
  answers and on a refused connection, which never reached the server; a connection cut after the
  request left retries reads only, since a write may have landed (the web page cannot tell the
  two apart, so its writes retry on 502 and 503 only). Long-polls ride on the same calls, so they
  reconnect without a notice. With #150 Caddy already holds requests during a restart; this
  covers what slips through, and self-hosted servers without that Caddy setup.
- 2026-10-06. A lost run says so (#249). The run killed with -9 in the fix check of #59 was lost
  on the phone already: its card had no time and no bar, as #190 decided, but its only line,
  "No news for 12 min 59 s", read as a quiet live run. Both clients now write "Lost, no news for
  12 min 59 s". Nothing keeps a dead run alive: a run's heartbeat lives in the `starbridge run`
  process, so after a kill the server keeps its last update, without an exit, and each client
  turns it lost 3 minutes after that update with no server-side expiry, since the server cannot
  read a sealed run.
- 2026-10-06. Deploys without downtime (#150, owner ruling of 2026-10-05). Caddy holds a request
  for up to 30 s (`lb_try_duration`) while its upstream is down, retrying every 250 ms, and
  checks each upstream's health every second. The page runs as two copies, `web-a` on 3010 and
  `web-b` on 3011: a deploy starts the idle one, waits for its health, then stops the other.
  Caddy sends every request to the first healthy copy (`lb_policy first`), so it switches
  without a config change and the two builds never serve at once. A page loaded before the
  switch may still ask for a script chunk of the old build, which the new copy lacks; Next.js
  then reloads the page, as it did before #150. The server stays one instance,
  since it holds the long-polls and SQLite: on SIGTERM it ends every long-poll as if its wait
  passed and exits, and the client's next request waits in Caddy for the new server. Each deploy
  loads the Caddyfile into the running Caddy through its admin API (`/load`), since recreating the
  container drops every connection. The idle copy's failed health checks stay out of Caddy's
  log. Checked on a local copy of the stack (the compose file, Caddyfile and `apply.sh` as
  committed, in Docker-in-Docker): during the first deploy from the old layout, a deploy that
  replaced both images, and one that changed the Caddyfile, a script that requested `/healthz`
  and `/` and opened a 1 s long-poll every 200 ms saw no failed request; the server's restart
  held requests for at most 1.3 s. Rolling back to a release from before this one brings back
  the old restart gap.
- 2026-10-05. A blocked question shows by its look, not a state line (#191, owner's pick of
  proposal B, "Filled and hollow"). This
  replaces the "Waiting for you 1:12" tag of the #166 entry above. A question whose agent waits
  on it is filled: `accent-soft` behind the whole item (the web row, the Android card, the head
  of the web detail and of the Android sheet), its question at weight 500, its kind icon (the
  speech bubble) in amber. A question its agent works around is hollow: no ground, an outlined
  card on Android (`line-strong`, no fill), its question at weight 400, its icon in `fg2`. A
  permission prompt always blocks, so it looks like a waiting question. The time goes in the
  meta row's time slot: while an agent waits, a clock ticking m:ss in amber at weight 500 from
  when it started waiting (a prompt from when it was asked), else the item's age. No row,
  card, sheet or notification carries a state tag, prompts included; screen readers hear
  "Waiting for you, 2 minutes" at the start of the item's label (web `aria-label`, Android
  `stateDescription`). Without colour the state still reads: fill against outline, 500
  against 400, a clock against an age. Kind icons: Android prompt cards already draw the
  terminal symbol in amber, and question cards gain the question symbol before the question,
  amber while the agent waits, so both clients colour kind icons alike (the owner's fallback,
  no coloured icons anywhere, applied only if Android could not). A flip to waiting moves the
  item up with the expressive spring (web: `motion.state`), fills it and starts its clock at
  0:00; a flip back moves it down, hollow, with no alert. Android notifications: waiting
  questions post on their own high-importance channel, "Waiting for you"; questions the agent
  works around on "Questions", at default importance (sound, no heads-up). Both are new channel
  ids, since Android never lowers an existing channel's importance; the old "Decisions" channel
  is deleted. A flip cancels the notification and posts it again on the other channel: alerting
  once to waiting, silently back. So the phone hears of a flip back, the machine now pushes it
  too, where #122 posted it `quiet`; clients post nothing audible for it. While the agent waits, the header ticks (the public version on the lock screen too).
  The text is the agent's context, with inline code set in mono rather than shown with
  backticks; a prompt's title is its tool alone ("Bash"). Web push keeps one word, since
  nothing else there can be styled: a question pushed as waiting reads "Waiting · machine ·
  project".
- 2026-10-05. A question's first option is the agent's default (owner, #191). Agents still
  never answer for the owner (#122), and nothing happens when the owner does not answer, so a
  default has no timer; it is the agent's proposal. The skill tells agents to list their
  default first (`--recommended` still names it when it is not). Clients show it first, as the
  one filled amber button, first; the Android sheet adds a check (#254 dropped the "Default"
  label both clients showed after it, since place, check and amber already say it). Screen
  readers hear "Default" (Android's `stateDescription` "Recommended" becomes "Default"). The protocol is unchanged:
  `recommended` names the default, and `default` stays what older clients need.
- 2026-10-05. Group by waiting (owner, #191). The inbox's view menu offers three groupings,
  remembered on the device: none (one feed), "Group by machine", and "Group by waiting", which
  sorts under two headers: "Waiting on you" with its count in amber (prompts and questions
  whose agent waits), and "When you can" with its count in `fg2`. Runs stay above the groups,
  as in the one feed, and the order inside each group is the feed's. Items look the same in
  every grouping. A saved "Group by machine" carries over.
- 2026-10-06. Permission prompts are capped like decisions, and storage counts rows (#260, audit
  finding). Prompts had no count cap and were charged only their ciphertext, so at the post
  rate an account could keep about 1.2 million in a week for 1.2 MB of quota. Now an account
  holds at most 10000 prompts, and each item is charged its boxes plus 512 bytes for its row
  and for each box's row. The other kinds need no cap of their own: each answers, notes or
  settles one capped item, or replaces the last snapshot. A post reads the account's counts
  from a totals table that triggers keep, and indexes on `re`, on kind and sender, and on a
  box's item mean no post reads all of an account's items or boxes.
- 2026-10-06. The directory cap stops adds, never revocations or recovery (#260, audit finding).
  A chain of 200 entries refused every append, so a lost machine's token could no longer be
  revoked, and an owner who lost every device could not recover. From entry 200 on, the server
  refuses a device-signed `add` with `directory-full`, always takes a revocation (each member is
  revoked once, so they never outnumber adds), and takes up to 20 recovery-signed adds. The
  chain stays bounded, at about 440 entries, for clients that replay it whole. No compaction:
  a checkpoint would need a new trust rule for pins, which 200 entries of churn does not
  justify; a full account still starts a new chain through the operator.
- 2026-10-06. Server rechecks after waiting (#260, audit findings). A queued push is sent only
  if its subscription and device are still active when its turn comes, so revoking a device
  stops pushes already waiting for it. Every long-poll (`GET /joins`, `GET /joins/:id`,
  `GET /answers`, `POST /quota/ask`, `GET /pairings/:rendezvous`) identifies its caller again
  after the wait and answers 401 if the session or token was revoked meanwhile. Usage counts
  key machines and devices by account and member id, since member ids repeat across accounts.
- 2026-10-06. Bounds on anonymous analytics, and no rollback from Actions (#260, audit findings).
  `/stats/api/send` is open to anyone and Umami stores every event, so its Postgres volume
  could fill the VPS disk. Caddy, now built with `caddy-ratelimit`, takes 30 events a minute
  per address (IPv6 per /64) and 300 in all, 8 KB each, and answers 429 past that; an hourly
  timer keeps each Umami table to 180 days and a million rows. Umami's data is worth little,
  so dropping events beats filling the disk. The Actions deploy key could deploy any ancestor
  of main, including releases without today's limits; `starbridge-deploy` now deploys only
  main's head or a commit on main that contains the deployed one. Rollbacks stay with the
  owner, through `deploy/deploy.sh`. Caddy's image pins its version, since a new image
  recreates Caddy and drops every open connection: that happens only when
  `deploy/caddy.Dockerfile` changes, and is the one deploy step that is not zero-downtime.
- 2026-10-05. A typed reply on every question (#201, owner). A question with options also takes
  a typed reply, as a side option: a neutral text button "Reply" after the options in the web
  detail and the Android sheet opens a text field with Send. Rows, cards and notifications do
  not carry it; they open the question. A question with no options stays typed only. The reply
  goes alone, with no choice, and the agent gets the same line as any typed answer: `Answer to
  d_… (question): <text>`. Protocol: an answer to a decision with options carries `choice` or
  `text`, and a machine checks the choice against the options only when there is one. A CLI
  from before this change rejects a text-only answer to a decision with options, so the
  answer would be lost: the CLI marks the decisions it posts with `replies: true`, and clients
  show Reply only on those. The skill still asks for options good enough that one of them is
  right, and says a reply is a steer to act on.
- 2026-10-05. Inbox motion on the web, as DESIGN.md's "Motion and states" lists it (#191).
  Only rows whose order among the listed rows changes slide, such as a question flipping to
  waiting and the rows it passes; rows that shift because an item came or left jump, so an
  answered row's gap closes at once. Changing the grouping or the search moves nothing. Items
  listed in the first 1.5 s after the list shows came with the page and don't fade in, since
  the inbox, prompts and runs load one after another. History's rows fade in only when the
  owner opens it, not when the page loads with it open.
- 2026-10-06. Launch positioning (owner, launch copy pass). Starbridge is the control surface
  for your coding agents, and it should look as simple as it is. The landing page, the docs, the
  README and the launch post sell two features, each by why it matters to the reader:
  - Questions. An agent asks for a decision that is yours, you answer with one tap on your phone
    or in a browser, and the answer reaches the waiting session as its next prompt. The work
    goes on while you are away from the terminal.
  - Runs. A run is anything an agent starts that you want to follow closely because it affects
    you: something time-sensitive, heavy work on your machine, a build, a release, an eval, or a
    test that takes over the screen or keyboard. Its progress stays on your lock screen until it
    passes or fails. Taking over the screen is one example, not the definition.
  - Quotas get one line, not a section or a place in the hero (owner, overriding a first
    framing): what's left on each AI plan, read from CodexBar, with an optional alert before a
    window runs out. Users don't launch agents from Starbridge, and the power users it targets
    run several accounts behind their own proxies and don't check quotas by hand. Alerts are
    opt-in per device and per provider, so copy never says they are on.
  Permission prompts stay a secondary, opt-in feature. The copy says "on each machine that runs
  agents", never "on each machine" alone, and "sign in on the web or in the Android app".
  Contact on `/privacy` is privacy@starbridge.run; abuse@ appears only in `/terms`, for
  takedown and abuse reports.
- 2026-10-06. Why the original mark stays, and the web's lockups (owner, after three rounds of
  mark concepts on https://claude.ai/artifact/9ddJ2PwPrBc7KmQdeDVqDN). A space elevator's tether
  must be vertical, which ruled out the tilted R5. On the web the name stands on the mark's
  baseline in the rail, landing nav, docs header and first-run frame, as the Logo entry below
  sets for Android.
- 2026-10-06. Web layout round (owner).
  The inbox's detail pane scales with its width: from a 1000 px pane (side panes narrowed, or a
  wide screen) its content takes 86% of the pane up to 1280 px, attached images show up to
  560 px tall, and the question and the agent's text step up one size (DESIGN.md `wide`).
  Below that it keeps today's 720 px column. Thumbnails on a row shrink with a narrowed list
  rather than running past its edge. The View button is an icon with the tooltip "View", and
  its menu drops "Remembered on this device", since the inbox's head is dense.
- 2026-10-06. Find on Android is option A of https://claude.ai/artifact/9ddJ2PwPrBc7KmQdeDVqDN:
  a search icon beside View in the Inbox's title row opens Material 3's search view, full screen
  over the bottom bar. It matches as the web's Find does (every word, in the machine, repo, the
  agent's words or the session, and a History item's answer) and lists the open matches under
  "Needs you", then "History". Runs are left out, since Android has no page for one. Enter opens
  the first result, Down moves into the list, Escape clears and then closes, Back closes.
- 2026-10-06. Logo: the original mark with the baseline lockup ("Starbridge" stands on the mark's
  ground line, the gap 0.4 of the mark). On Android it heads the Inbox above its title (mark 24 dp,
  name 22 sp), as Android has no top app bar, and the first run (mark 56 dp, name 40 sp).
- 2026-10-06. Find on the web searches History too (owner picked option 1 of
  the layout round). The rail's Find box and its `/` key stay;
  while it holds a query, the list shows the matching open items in one feed, whatever the
  grouping, then "History · N" with the matching answered items, History open or not. A
  History item also matches by its answer. Matched words show bold on `surface2`, never in
  amber; Escape in the box clears it. Android's search waits for the owner's pick.
- 2026-10-06. Answers on the machine (#260, from the Codex audit). A machine accepts a
  decision's answer only from a device the decision was sealed to (it keeps each decision's
  recipients), only while the decision is open, and never for an `answerIn` decision. A settled
  decision's answer is never delivered, even one accepted before the settle, because the server
  could hold a signed answer back until the agent moved on. `settle` closes the decision locally
  before it posts, and `wait` on a settled decision fails at once. Decisions asked before this
  change have no recipients on record and take no answer; the agent asks again.
- 2026-10-06. A stalled server never holds a permission prompt (#260, from the Codex audit).
  The hook's deadline and SIGTERM cut every request it makes, the prompt's post included, on
  both paths; the agent cuts its post when the hook hangs up or the hook's wait passes. A SIGTERM
  that lands while the prompt is being posted settles it by its call's input hash, and a post
  that fails leaves the prompt settled on the machine, so no later answer applies. The Pi link
  stops the CLI after 600 s and gives a stopped CLI 10 s before it defers and kills it, so "Answer
  here" always reaches pi-permission-system's dialog.
- 2026-10-06. Withheld revocations (#260 P1, from the Codex audit). A machine cannot tell a
  current directory from one the server cut short: the pin only stops rollback past what the
  machine saw, and any freshness statement the machine could ask for, the revoked device's own
  key can sign. So the rule is detection on contact: devices sign the directory head they hold
  into each answer (`dir`), the machine keeps the longest head per device, and it refuses every
  device answer while a device active in its chain has signed a head that chain lacks. A
  withheld revocation then holds only until another device answers that machine; after that the
  server must drop all of the owner's other devices' answers to it. Closing the gap fully needs a
  channel the server does not carry. Answers without `dir`, from clients before this, are still
  accepted.
- 2026-10-06. The web's Reply, as Android's (#254, owner). Reply in the web detail is Material 3's
  filled text field, one line that grows with the text, with its send icon button inside,
  centred on the field's line, as #264 made it on Android. The "Default" label is gone on both
  clients; the web keeps it for screen readers only.
- 2026-10-06. Quotas and Settings on wide screens (owner, from
  https://claude.ai/artifact/9ddJ2PwPrBc7KmQdeDVqDN). Once the page is 840 px wide (a window
  about 1210 px wide, with the rail) the Quotas page is one table up
  to 1200 px wide, as dense as the inbox: the provider in a first column, then a line per window
  (name, meter, figure, state, reset); narrower screens keep a card per provider. Settings puts
  each section's name in a 220 px column beside its box, whose rows stay 720 px. Providers
  reorder live on the Quotas table and in Settings: the row follows the pointer (mouse, pen or
  touch), the others slide aside, and the order is saved once it lands; the arrow keys, Home and
  End move a focused handle, and a polite live region says where it went. On the Quotas table a
  provider leading under "Running out first" keeps its place, one with a leading row on another
  machine is a barrier the others don't cross, and the others take the places
  they held among themselves; narrow screens reorder in Settings. The web gets Sign out under
  Settings, Account, as Android has: the browser leaves the account's devices unless it is the
  last one, ends its session, drops its push subscription and forgets its keys and answers.
- 2026-10-06. A group pinned by "Running out first" shows a pin in its drag handle's place on
  the Quotas table (owner, #296), so the column stays aligned and the missing handle is
  explained. A tap or click opens a popover, not a `title` tooltip, which phones never show
  (#285): "First because it runs out soonest. Change in Settings.", Settings linking to the
  setting. Android's Quotas screen has no reorder handles, so it has no pin.
- 2026-10-06. A prompt sheet's full input opens in place (#265): "Full input" is a full-width
  row with a chevron at the end of the sheet, and the JSON expands under it, as Material's
  expandable sections do. Nothing above the row moves, so Allow and Deny stay where they were.
  A full-screen view was the other option; it hides the command and the buttons while the
  owner reads, for an input that is rarely long.
- 2026-10-06. One card system for the inbox (#248, owner's pick from
  https://claude.ai/artifact/2eJzH4btTJsQ77CByvBQsB). This revises #191's "filled and hollow": a
  question its agent works around was an outline with no fill, so it read as another component
  beside the runs and prompts. Now every item (run, prompt, question, History's head and rows) is
  a filled card on `surface`, Material 3's filled card, with no border and no shadow, and what
  blocks an agent differs by one thing: its card takes the amber fill (`accent-soft` over
  `surface`). The title's weight, the clock in the time slot and the screen reader's label stay as
  #191 set them. How the items sit depends on the view, as the owner picked: in One feed each
  item stands apart; under "Group by machine" and "Group by waiting", the items under one header
  are visibly joined, since a group under its header reads as one set; so is History in those
  views. Android follows Material 3 Expressive literally: filled cards, corners `radius.xl` (28
  dp), 20 dp inside, 16 dp page margins, `s2` apart in One feed (Material's spacing in a
  collection of cards; History's one-line rows round at 20 dp, since a corner scales with its
  container), and a segmented group when grouped, 2 dp apart with `radius.xs` inside. The web
  takes the idea, not Material's shapes (owner: "we're not making a Material 3 web app"): it keeps
  the dense look of Design v2's direction A, and each item is a box as the web's settings rows
  are (`surface`, a `line` border, `radius.sm`), `s2` apart in One feed; when grouped, a group's
  items share one such box with hairline dividers. Kind icons sit on the item without a tile on
  both clients, amber on a blocked item and `fg2` otherwise. The question sheet and the web
  detail keep their
  amber head or ground; #254 changes their options and Reply.
- 2026-10-06. Allow covers what the owner saw (#274, web client 1 and 2). A permission's
  `summary` is one line capped at 200 characters, so a command could hide a destructive tail
  past it. The web detail now shows the whole redacted `input` (a command in full, else
  indented JSON), and Allow, its key and the wider grants wait until the input's end has been
  on screen. A phone row keeps Allow only when the whole input fits on one line of 200
  characters, shown whole. Session and project grants show their exact rule beside their
  label instead of in a tooltip, which touch screens never show.
- 2026-10-06. A browser's keys and its notifications' account (#274, web client 3 and 4). Signing
  in binds the session to the stored device; a failure that is not a refusal (network, 5xx,
  rate limit) now retries after 0.5, 2 and 5 s and then shows the boot error with its retry,
  instead of sending a browser with valid keys to pair again. A join keeps its new keys under
  `pending` and makes them the device only once a device approves it, so a join started for any
  reason never overwrites an active device's keys; a
  join approved but cut off before that step resumes at the next boot, once the directory lists
  its keys. A decision's notification stores the account
  it was shown for, and its actions answer for that account only; one from before carries none
  and opens the page instead of answering.

- 2026-10-06. A new user's first question needs no prompt and no sandbox flag (#245, launch
  walk). In Claude Code's default mode `starbridge ask` stopped at a permission prompt before
  the question existed, and in Codex's default sandbox it had no network. Setup now asks to
  allow `starbridge ask`, `waiting`, `working`, `wait` and `settle`: Claude Code allow rules in
  `~/.claude/settings.json`, and a Codex execpolicy file, `~/.codex/rules/starbridge.rules`, whose
  `allow` runs them outside the sandbox. `starbridge run` stays out of both, since the command
  it wraps is the agent's own. Uninstall removes both.
- 2026-10-06. A `codex exec` session gets its answer through `wait` (#245). `codex queue`
  accepts a message for an exec thread, but nothing runs it once exec returns. The CLI reads the
  thread's rollout (`$CODEX_HOME/sessions/YYYY/MM/DD`, dated by the UUIDv7 thread id): an
  `originator` of `codex_exec` or a `source` of `exec` means `ask` says to `wait`.
- 2026-10-06. `pair --force` stays on the machine's server and name (#245); before, it paired a
  self-hosted machine with starbridge.run under its hostname. Setup restarts an agent running
  another version (a brew or npm upgrade), and the agent rewrites an outdated Codex skill when
  it starts, so `starbridge update` also brings Codex the new skill.

- 2026-10-06. Supply chain, #274 findings 2 to 4. Setup installs the plugins only from a
  marketplace whose source is this repository: `claude plugin marketplace list --json` gives
  `{source: "github", repo: "owner/repo"}` for an `owner/repo` add and `{source: "git", url}`
  for a URL add; any other `starbridge` marketplace makes setup stop and say how to remove it.
  Codex delivery queues only `Starbridge has the owner's answer to <id>: run starbridge wait <id>`,
  since `codex queue` (0.160) takes the message only as an argument and other local users can
  read process arguments; `wait <id>` prints a delivered answer from local state. The npm bundle
  runs under Node, so the CLI uses no Bun global without a guard; a test runs it there.
- 2026-10-06. Android posts the account's first directory entry only once the recovery key is
  confirmed (#370), as the web does since #337. "Create the keys" writes the keys, the seed and
  the signed entry to the app's encrypted store; "I wrote this key down" posts the entry, then
  drops the seed. The seed is stored exactly as long as before, and an app killed in between
  shows the same key again. Data cleared before the confirmation leaves the server empty, so
  signing in again starts the setup over instead of offering only "Add this phone".
- 2026-10-06. A prompt in History says how and where it was answered, as a question does (#349):
  "Denied · on Pixel", "Allowed for this session · on this browser", and no separator when nobody
  answered ("Expired"). Answers are sealed to the asking machine, so other devices learn the
  allow or deny from the machine's settled notice, which now carries `behavior` beside `device`;
  a notice from an older machine reads "Answered".
- 2026-10-06. "Running out first" pins every leading group, in the provider order, so only the
  group whose window runs out soonest says so (#351): "Up top because it runs out soonest."; the
  others say "Up top because it's running out.", each followed by "Change in Settings."

- 2026-10-06. Tests clean up their temp dirs (#313): a day of sessions left about 13,000 in the dev
  box's 4 GB RAM-backed /tmp. Each package's `bun test` preloads `test-tmp.ts`, which points
  `TMPDIR` at one dir per run and removes it after the last test, failed or not, and on exit or a
  signal. Android's store tests use JUnit's `TemporaryFolder`. The
  skill eval removes its homes on exit, after a throw or a signal too, and the judge its scratch dir.

- 2026-10-06. A revoked browser stops showing its data (#343). Any 401 while the page runs sends
  it back through boot, which drops the inbox, prompts, quotas and runs from memory; an unsigned
  401 still only shows the refusal and keeps the keys (#310). Once the verified chain shows the
  browser revoked, it deletes its keys, sent answers and push subscription, keeps the pin, and
  says "This browser was removed from your account by <device>" (or "by your recovery key"), as
  Tom worded it.
- 2026-10-06. Android shows nothing from a machine its directory revokes (#344), as the web
  already did: its questions, prompts, quotas and runs leave the Inbox, and the notifications of
  its questions and prompts close, whether this phone or another device revoked it. They stay
  saved, unshown, like every item the phone keeps.

- 2026-10-06. CI runners on dell2 (#392), a host for CI only (6 cores, 13 GB visible). Two
  runners: `dell2-1` with the label `starbridge-android` alone, so Android builds never queue
  behind CI jobs, and `dell2-2` with `starbridge-devbox`; jobs spread with no workflow change.
  Android builds left the dev box when `devbox-1` lost `starbridge-android`.
  `deploy/setup-runners.sh` installs #380's system units in `ci.slice` on every host. It takes
  the runners as `RUNNERS="name:labels ..."` (the dev box's three by default), a `RUNNER_TOKEN`
  for hosts without gh, and `GRADLE_PROPS`, written to the shared Gradle home, which Gradle reads
  over the project's: dell2 keeps `-Xmx4g` and caps workers at 4. At launch the dell2 runners go
  with the dev box's (#59): a repo-level runner serves a fork's copy of any workflow, and runner
  groups that limit runners to chosen workflows exist only for organizations.

- 2026-10-06. A device that joins later reads the questions already waiting (#340), as #158 did
  for quotas. Decisions and permission prompts are sealed and signed to the devices in the
  directory when asked, so a new phone, a browser that signed in again or a recovery read none
  of them. Each answer poll now checks the machine's open decisions and prompts against the
  active devices; when one lacks a device, the machine re-signs it with the full recipient list
  and posts it again under its own id, with the decision's waiting state. The server takes such
  a re-post only from the machine that posted the item and only while it is open, keeps its
  arrival time, so a prompt's 10 minutes do not restart, and pushes only the devices that were
  not recipients yet. Revoked devices are not active, so they get nothing, and nothing is
  re-sealed while the machine finds the directory behind (#280). A decision keeps its signed body
  in the state (0600, like the rest) for this, only until it is answered or withdrawn; its images
  are read again from their files, and one moved since is left out. A re-post says `reseal`, and the server refuses one for an item it no longer holds, so a
  dropped decision never comes back. The machine counts the new devices' answers before it posts,
  since a post whose reply is lost may have reached the server. A server that withholds a
  revocation no answer has revealed yet can still get an open item re-sealed to that device, as it
  can for a new question; re-sealing stretches that to the item's life.
- 2026-10-06. Back on a phone's web page closes an open item first (#347). Under 1100 px, the
  item shown in place of the list sits in the address as `/?item=<id>`, pushed as its own history
  entry, so Back, Android's back gesture and an installed app's Back return to the list; a reload
  keeps the item open, and a link to `/?item=<id>` opens it with the list's entry put behind it, so
  Back from a link also returns to the list (Chrome may skip that entry on its own Back, as no tap
  added it; the in-page way back always reaches it). The in-page way back steps back through history, so
  it leaves no entry behind. A wide window pushes nothing: once the inbox loaded, it selects a
  linked item beside the list (opening History for a closed one) and drops `?item`. Image and confirm dialogs are modal `<dialog>`s,
  which Chrome on Android closes on the back gesture before it leaves the page.
- 2026-10-06. An answer is never lost on Android (#329, #331). The app seals and signs an answer,
  then keeps it on the phone before posting it, so an answer tapped offline waits there,
  ciphertext only, until the server takes it. WorkManager sends it once a network is up, the app
  closed or not, and every sync tries again. It ends answered, answered on another device, or
  refused, with the server's reason shown and the buttons back. While it waits, the sheet keeps
  the tapped option filled and the other options locked, as while sending; a snackbar says it goes
  out when the phone is back online; a notification says "Hold · waiting to send". A tap on a
  decision this phone answered, or whose answer waits, repeats that outcome instead of failing,
  so a double tap on a notification button sends once and says "Answered". The server answers
  `already-answered` to a retry of an answer it took before its reply was lost, and does not say
  by whom; the app counts it as its own when an earlier attempt may have reached the server (the
  connection cut after the request left, a 500, or the notification's 9 s limit), and as another
  device's otherwise.
- 2026-10-06. Harness integrations audit (#298), each finding reproduced in a throwaway HOME
  with Claude Code 2.1.289, Codex CLI 0.160.0 and Pi 1.0.4 with pi-permission-system 39.1.0.
  Fixed here: an agent passes its variables to the agents it starts, and a `codex exec` run
  from a Claude Code shell posted as that Claude session, whose mod then got the answer (#319).
  So `ask` takes Codex or Pi over Claude Code when both are set, unless Claude Code runs as
  `claude -p`, the only way Codex and Pi, which run commands without a terminal, can start it. A Codex sub-agent asks under its
  root thread, read from its rollout's `session_id`, since `codex queue` refuses sub-agent
  threads (#320). `claude -p` (`CLAUDE_CODE_SESSION_ATTENDED=0`) is told to `wait`, since the
  mod runs only in interactive sessions (#321). Filed post-launch: Pi needs allow rules for the
  `starbridge` commands under pi-permission-system (#322), uninstall leaves `starbridge` in its
  `authorizerChain` (#323), a bare `wait` takes any session's answer (#324). Checked and fine:
  setup run twice changes nothing; Claude Code `--resume` and Pi `/new` then `/resume` get an
  answer given meanwhile; Pi `/reload` keeps the permission link; `codex queue` starts the
  daemon itself, so an answer given after a reboot still reaches the session. After the TUI
  quits, Codex's daemon keeps running and runs the queued answer as a turn nobody watches,
  which `codex resume` then shows.

- 2026-10-06. The agent binds its socket under a 077 umask and restores the process's after
  (#95). Under the usual umask the socket took other users' connections between the bind and the
  chmod to 0600, and a connection accepted then stayed open.

- 2026-10-06. Recovery with the words keeps its new keys under `pending` until the directory
  append lands, as a join does (#283, after #274). A failed append leaves the stored device's
  keys alone; one that landed with its reply lost counts once the directory lists the entry. Boot
  adopts a pending record the directory lists as active even when an older device is stored, so a
  recovery or join cut off after it landed is not lost to the older keys.
- 2026-10-06. Waiting pairings are capped per address, not only server-wide (#309, after
  #302). `POST /pairings` needs no account, and 500 IPv6 /64s, a sliver of one free /48, kept
  the server's 5000 full so nobody could pair. Each address may now hold 20 unapproved
  pairings, an IPv6 client counting as its /48 on this route; approved ones do not count, so an
  office behind one NAT pairs everyone, 20 waiting at once on top of the 10-a-minute rate
  limit. The server-wide cap, now 20000 (about 80 MB of 4 KB requests), stays as the disk
  bound, and filling it takes a thousand addresses or /48s. The cost: subscribers of a mobile
  carrier that hands out /64s from one /48 share its 20, so one of them can block pairing there
  for 10 minutes, a far smaller blast radius than the whole server. Approving one's own
  pairings frees the slots, but each approval needs a directory entry, 200 per account.

- 2026-10-06. Add a device on the web says a failed pairing in the app's words, as Android does,
  not the API's code (#289): an expired or unknown code reads "No pairing with this code, or it
  expired."; a code already approved, a removed browser and an expired sign-in have their own
  sentence; any other error reads as the server's sentence, capitalised, without its code.

- 2026-10-06. Devices tells apart rows that share a name (#287). `pair --force` adds a new machine
  and leaves the old one active, and every machine defaults to the hostname, so Devices listed
  identical rows. A row whose name another shares now adds the time it was added ("added Oct 6,
  10:32") on web and Android, and `pair --force` names the old pairing as the earlier row, with
  its time and zone, instead of by an id no client shows. Revoking the old machine in the approval itself (a `replaces` field in the
  pairing request) would remove the twin but changes the protocol; not done.
- 2026-10-06. Pi's `path` and `external_directory` asks stay at the keyboard (#288).
  pi-permission-system 39.1.0 caps every authorizer link's allow on those surface families to
  defer (its delegation envelope, `src/authority/delegation-envelope.ts`, ADR 0007), so the
  second gate of a read outside the project, `external_directory_read`, opened its dialog even
  after a device allowed it. The Starbridge link now defers such asks at once, by the gate's
  surface, instead of sending the devices a prompt whose Allow is dropped. Letting a link allow
  them needs pi-permission-system to make the excluded families configurable (its #620).
- 2026-10-06. The web backs off together while the server is unreachable (#332). Each poller's
  call retried on its own every 250 ms to 4 s, so an offline page sent about two requests a
  second, and every open tab did the same to a server coming back up. Now every call in a page
  shares one backoff: 250 ms doubling to 30 s, with jitter between 50 and 100% of the step, ended
  by any answer and by the browser's online event. Pollers skip their turn during a wait, while
  every other call's first try goes out, since an answer, a push or a sign-in may be the one that
  finds the server back; only retries wait. A call that
  gets no answer throws "You're offline." or "Can't reach the Starbridge server." instead of
  the browser's "Failed to fetch". An offline banner waits for the owner's ruling on the mockup.
- 2026-10-06. Security headers (#312, after #302). Next sets the page's Content-Security-Policy
  in `web/src/proxy.ts`, because only it can put a fresh nonce on each request and on its own
  scripts: scripts need the nonce or `'strict-dynamic'` (so Umami's tracker, which Next's
  bundle loads, passes), `'wasm-unsafe-eval'` lets libsodium's WebAssembly compile without
  allowing JavaScript eval, and an inline script sets Zod's `jitless` before it builds its schemas,
  since its `new Function` probe counts as a violation even when caught. Styles stay `'unsafe-inline'` since React writes style attributes,
  images allow `data:` and `blob:` for questions, `worker-src 'self'` keeps the service worker,
  and `frame-ancestors 'none'` refuses framing. Fonts are self-hosted, so nothing else is
  allowed. A nonce needs a render per request, so every page is dynamic now, and the docs
  read their Markdown at runtime from files the image ships (`outputFileTracingIncludes`).
  Caddy sets what applies to every response, the API's included: HSTS for a year,
  `nosniff` and `Referrer-Policy: same-origin`; the self-host example does the same. Next
  stops sending `X-Powered-By`.
- 2026-10-06. The web posts the account's first entry only once the owner confirms the recovery
  key is saved (#328). The seed is dropped as soon as the key exists, so a page closed on "Save
  your recovery key" had already posted an account whose key nobody saw, and could never show it
  again. Now a reload before Continue finds an empty directory, says that key was never used,
  and makes a new one; the key is never stored, in IndexedDB or elsewhere. Replacing the key
  later needs a new directory entry kind, since entry 0 fixes the recovery public key; it waits
  for the owner's ruling on the mockup.

- 2026-10-06. Pi gets the allow rules Claude Code and Codex have (#322, #323, #324, from the #298
  audit). With pi-permission-system installed, setup offers to add `"starbridge ask *"`,
  `waiting`, `working`, `wait` and `settle` as `"allow"` to `permission.bash` in its config,
  after the owner's own patterns since the last match wins. A plain level there (`"bash":
  "ask"`) stays, and setup prints the lines to add instead: as `{"*": "ask"}` it would merge
  with a project's bash map rather than give way to it. Before it, Pi stopped every `starbridge ask` at a
  permission dialog. Uninstall takes out exactly those patterns and the `starbridge` link in
  `authorizerChain`, which otherwise made pi-permission-system warn at every prompt, and
  deletes the file when nothing else is left in it. A `wait` without an id, run in an agent's
  session, takes only answers to that session's decisions, so it cannot take one that another
  session's mod or `wait` is due; outside an agent's session it still takes any. Checked with Pi 1.0.4 and pi-permission-system 39.1.0: `starbridge ask` ran
  without a dialog while `touch` still asked, and uninstall left no config behind.
- 2026-10-06. Pi's allow rules also come with `starbridge config permissions on`, and cover the
  Starbridge skill (#443, found in the #427 fresh-user run). Setup offered them only when
  pi-permission-system was already installed, but setup's own hint installs it afterwards, so a
  new user's config held only `authorizerChain` and Pi asked four times before one question.
  Reproduced with Pi 1.0.4 and pi-permission-system 40.0.0: the skill's file is gated twice, as
  the `starbridge` skill (surface `skill`) and as a `read` that falls back to `"*": "ask"`; the
  `external_directory` gate auto-allows Pi's own package folder. So setup and `config permissions
  on` now offer `skill: {"starbridge": "allow"}` and `read: {"<agent dir>/git/github.com/T0mSIlver/
  starbridge/plugin/skills/starbridge/*": "allow"}` beside the bash patterns, each last in its map
  and skipped where the surface is a plain `"allow"`. An unmatched pattern falls back to `"*"`, so
  a map holding only these never tightens anything. After the fix the same run sent only the
  question; a read of the package's README, `touch` and `true` still asked. The second prompt was
  a `read` tool ask, which a link may allow, not a path ask: an `external_directory_read` ask
  still stayed at the keyboard, so the docs now say tool-rule asks reach the devices.
- 2026-10-06. Only the verified directory revokes a browser (#310, as Android decides). A 401
  `revoked` is unsigned, so the page keeps its keys and shows the refusal on the sign-in screen;
  after sign-in, boot reads the chain and shows "was revoked" only if the chain says so.
- 2026-10-06. The web page closes every notification the service worker shows when it signs out,
  when the chain shows its device revoked, and when it adopts new keys after a recovery or a join
  (#311, as #282 on Android). They stay up until dismissed and hold decrypted questions. The
  service worker checks the keys are still there before and after it shows one, so a push it was
  opening during a sign-out leaves nothing on screen.
- 2026-10-06. The recovery key can be replaced (#348, owner ruling after #328). Entry 0 fixed it
  for good, so an owner who thought the key leaked had no fix short of a new account. Two new
  directory entries replace it: `recovery` proposes a key, signed by a device and by the new key,
  and `recovery-confirm` makes it current, signed by the current key (PROTOCOL.md, "Replacing the
  recovery key"). The owner first asked for a second device to confirm when the key is lost; the
  review of #368 showed that path lets a stolen phone, which can add a device of its own, take
  the key over, and the owner dropped it: replacing always needs the current key, and an owner
  who lost it keeps their devices and no key. Clients refuse a chain with an `op` they do not
  know rather than skip the entry, since skipping one would keep a replaced key or a revoked
  device trusted; so web, Android, the CLI and machines must all update before anyone replaces a
  key. There is no Devices history, so the Recovery key row in Devices says when the key was last
  set and on which device, and every other device shows the change once.
- 2026-10-06. Recovery revokes every other device, and the recovery key revokes no one (#363,
  #364, found by the protocol audit). A recovering device holds no pin, so a server could serve
  it a chain cut short of a revocation, and its `add` made a fork where a stolen, revoked phone
  was active again. A new `recover` entry adds the device and revokes every other member,
  machines included (a revoked machine came back the same way, review of #368), so no fork keeps
  an earlier one; the owner pairs the devices and machines they still have again from the
  recovered device. A confirmation names the key it confirms, so a stolen device's later
  proposal cannot take the owner's confirmation. A plain `add` signed by the recovery key still verifies, since older chains
  hold it, but clients no longer write it. The recovery key could also sign a `revoke`, against
  PROTOCOL.md; verifiers now refuse it.
- 2026-10-06. Replacing the recovery key on the web and Android (#348). Devices gains a Recovery
  key row: when and on which device the key was set, with Replace. Replace asks for the current
  key, then shows the new key as first run does; like the first device's (#328), it reaches the
  directory only once the owner ticks the box. Without the current key the page says the key
  can't be replaced and the devices keep working. Every other device shows the replacement once,
  as a banner above the inbox, and remembers that it was dismissed.
- 2026-10-06. Layout breakage fails CI (#305). Every e2e screenshot, at 390 and 1280 px and
  checked again at 320, fails on a page wider than the window, a box that cuts its text without
  an ellipsis, text past its box, anything past the window's edge, text drawn over text
  (`web/e2e/layout.ts`), or anything the Content-Security-Policy (#325) blocked. Tap targets under 44 px and contrast under 3:1 are listed, not failed,
  until the owner rules on them. The e2e now covers worst-case content (a host-length machine
  name, unbroken branch names, 24 items, a permission prompt, a run) and runs in CI. It holds
  its ports from below 32768 until each server starts, so runners on one machine do not
  collide, and closing outgoing connections, which share the range above, do not block them. `AUDIT=<folder>` shoots every size from
  320 to 1920 px in both themes, plus 200% text at 390, and lists what the checks find.
- 2026-10-06. Android samples an image by its real size, read with `inJustDecodeBounds`, not the
  size the machine declares, drops one larger than declared or than 8192 px a side, and holds
  at most 4096² pixels in any decode (#360).
- 2026-10-06. Workflows pin every action by commit SHA, with its version in a comment (#361). A
  moved tag could otherwise run code in the release job before it writes the minisign key.
  Dependabot proposes the updates in one grouped PR a month.
- 2026-10-06. Both screens confirm a join by digits (#355, from the #366 audit). Only the
  approver's owner compared the digits; the joining device acted on the first approval it got.
  A server in the middle that sends the joiner its own approver key derives the same MAC key and
  forges an approval naming a chain of its own. Now the joining browser and phone show They match
  under the digits and hold any approval until the owner taps it, as Matrix SAS confirms on both
  sides. The CLI never joins by digits. On Android, a restarted wait no longer drops the join:
  its cancellation was caught as an `IllegalStateException`.
- 2026-10-06. A browser trusts a served directory only against its pin (#354, from the #366
  audit). On reload, the web adopted a join's or recovery's pending keys from whatever chain the
  server served, and a browser with no pin accepts any chain, so a server could enrol it into a
  chain of its own. Now a directory read with no pin trusts only a genesis its own device signed
  (a first device cut off before it pinned); otherwise it drops the pending keys and shows Join
  again. Joins and recovery pin before they save the device, so a device never exists without a
  pin, and a pending record with a pin is still adopted on reload as #274 and #283 need.
- 2026-10-06. Only the server could make the directory empty once a first device's genesis may
  have gone out, so a browser's keys stay then (#371, from the #302 audit). After #354, the only
  device a browser holds without a pin is a first device whose commit was cut off: joins and
  recovery pin before they save the device. Commit now marks the device as posted before it posts
  the genesis, and boot deletes a device's keys on an empty directory only when it is unmarked,
  as #328 needs; a marked one shows the broken directory page and keeps its keys. A commit
  whose post never reached the server, closed before the owner retried, also lands there. A
  tab still offering a first key cannot replace a device whose genesis went out. A 401 that says
  the device was revoked keeps the keys too, as #310's entry says.
- 2026-10-06. Android allows only what the owner saw whole, as the web does since #276 (#356). A
  notification's Allow sends at once only when the whole input fits the one line a collapsed or
  heads-up notification shows (owner's rule); otherwise it opens the prompt's sheet. A card's
  Allow sends only when the card shows the whole input uncut, else it opens the sheet too. The
  sheet shows the whole input and enables Allow once its end has been on screen.
- 2026-10-06. Lock-screen Allow opens the command first (owner's ruling on #389, replaces the
  lock-screen Allow of #57 and #182). It still asks for the unlock, then opens the prompt's sheet
  with the whole command, Allow one tap away; it no longer sends. Deny still answers from the
  lock screen.
- 2026-10-06. One opt-in skips both (owner, #390): Settings, Notifications, "Quick Allow"
  ("Allow from a notification without seeing the whole command. Unsafe."), off by default. On, a
  notification's Allow sends right after the unlock on the lock screen, and at once from a
  collapsed or heads-up notification whose command does not fit its line.
- 2026-10-06. Permission text shows control and format characters as escapes (`\u202E`), on the
  machine before sealing and again in every client, so a bidi override cannot reorder the
  command the owner allows (#357).

- 2026-10-06. Main's CI runs one at a time (#380). Each merge used to queue its own run, and
  deploys waited behind all of them: six main runs queued for up to 30 min with prod six merges
  behind. Now one runs and only the newest merge waits; a newer merge replaces it, and a replaced
  run deploys nothing, so merges in between are deployed with the head. Deploy's own queue is on
  its job, so a deploy skipped for a cancelled run cannot replace one that is waiting. A
  re-run by hand of an older main run replaces the waiting head the same way.
- 2026-10-06. Faster CI on the dev box's runners (#380). Over CI's first 199 runs, jobs waited
  longer for a runner (e2e: 7.2 min median, 17 min p90) than they ran (4.3 min). A pull request
  now runs only the jobs its files can affect: no checks for an Android-only change (unless it
  edits `Tokens.kt`, which web's tests compare with DESIGN.md), no e2e for Android, evals or
  Markdown that no page renders. Such a job still starts and passes in seconds, so its check
  reports success; main runs everything. pnpm's store and Next's `.next/cache` stay on each
  runner (`$RUNNER_TOOL_CACHE`); the store used to sit in the job's temp folder, so every install
  downloaded every package, and setup-node uploaded it to GitHub's cache after every e2e, ~50 s.
  The e2e runs under `.github/watchdog.sh`, which after 10 min prints its processes (Firefox
  included, which Playwright starts in a session of its own) and their sockets, then stops them.
  The runners are system units in `ci.slice` at CPU weight 400 to `user.slice`'s 100, where the
  agent sessions build: `pnpm typecheck` on the loaded box took 8.7 s there against 14.3 s as a
  user unit at Nice=5. "test, typecheck, lint" stays one job: split, it would install three times
  and take three runners, which are what is short.
- 2026-10-06. `ask --default` is gone from the help and the skill (#352): no client shows it, so
  an agent that passed one believed the owner saw it. Like `--default-at`, it is accepted and
  ignored with a warning, so older commands still post; the CLI always sends "Waits for your
  answer" for clients from before 2026-10-05. `ask --help` now lists `--timeout`.
- 2026-10-06. A permission's `inputHash` is keyed under the machine's signing key (#359). Devices
  only echo it, and the machine matches calls by it locally, so nothing else changes; unkeyed, a
  device holding the redacted input could test guesses for a short redacted password. The
  summary and description are cut from the input after `redactValue`, so secrets under a key's
  name stay out of MCP and Task summaries too (#358).
- 2026-10-06. Devices detecting a withheld machine revocation (#362, from the #366 audit). #280's
  check runs one way: machines read the heads devices sign into answers, but devices read no head
  from machines, so a server holding a revoked machine's key can keep one device answering it.
  The fix mirrors #280: machines sign `dir: {length, head}` into every item, and a device refuses
  every machine's items while an active machine has signed a head its chain lacks. It needs a
  schema change in `packages/protocol` and its Kotlin twin, signing in the CLI, and the hold in
  the web and Android clients, well past one small PR, so it goes in that order as separate PRs.
  Until then PROTOCOL.md states the device-side limit. Now, a `settled` notice closes only the
  signing machine's decisions on the web and Android, which applied it by item id alone.
- 2026-10-06. Devices detect a withheld machine revocation before launch (#362, the owner's
  ruling). Three PRs: the protocol (an optional `dir` on every machine-signed body, and
  `noteHead`, `withheldBy` and `headToSign` with their Kotlin twin), then the CLI signing heads,
  then the web and Android holding items. A machine signs the longest head it knows, a device's
  included, so a machine the server also keeps behind still passes on what a device told it. The
  head is optional so that older machines' items keep opening; they only add no evidence. Older
  devices drop the field and run without the check, as before.
- 2026-10-06. How devices hold machines' items (#362, PR 3). The web and the phone keep the
  longest head each machine signed, in IndexedDB and on disk, and while one counts they show no
  machine's item, raise no notification and send no answer. The web says why in a banner above
  every screen; the phone shows it as a notice. Settings, and so revoking, keep working, since a
  compromised member's false head ends only once the owner revokes it. The phone reads every
  head on a page before it applies any item, and keeps its cursor while held, so the items come
  back once the server serves the missing entries.

- 2026-10-06. opencode is the fourth harness (#300; research below, opencode 1.18.31). Its
  plugins get an SDK client bound to the running server, so the Starbridge opencode plugin
  (`mod/opencode/starbridge.ts`) submits each answer with `client.session.promptAsync`, through
  the mod's answer loop (`agent.ts`, `poller.ts`, `switch.ts`) as in Pi. One opencode process
  serves many sessions, so the plugin runs one loop per session, from the first command that
  session runs. It sets `STARBRIDGE_OPENCODE_SESSION` (the session's id) and
  `STARBRIDGE_OPENCODE_TITLE` for every command through the `shell.env` hook, since opencode
  gives commands no session id of its own, and `STARBRIDGE_OPENCODE_ANSWERS` (the id again)
  unless the process is `opencode run`, which exits once the session is idle, or the session is a
  subagent's (it has a `parentID`), which ends with its task: there the agent waits. `ask` detects
  opencode from the first variable and says the answer comes back as a prompt only when the third
  matches it, as for Pi; the field that carries this to the agent, `piAnswers`, becomes
  `extensionAnswers`. The plugin appends `plugin/hooks/rule.md` to the system prompt through
  `experimental.chat.system.transform`, the only hook that adds to it. Permission prompts: the
  `permission.ask` hook is declared but never called, but every prompt publishes a
  `permission.asked` event, and a plugin can answer it with `POST /permission/{id}/reply`
  (`once` or `reject` with a message) while the TUI shows its dialog. So the plugin runs
  `starbridge hook permission --agent opencode` on each one, which does nothing while
  `starbridge config permissions` is off (the default), and the first answer wins: a reply from
  the keyboard (`permission.replied` with another reply than the plugin's) stops the CLI, which
  settles the prompt on the devices, as does the session going idle with the prompt out (Esc).
  opencode settles a session's other prompts itself when one is rejected; those show as answered
  at the keyboard.
  The devices offer Allow (this call) and Deny. `opencode run` rejects every prompt at once, so
  nothing reaches the devices from it. `starbridge setup` offers, when `opencode` is on the PATH,
  the skill in `~/.config/opencode/skills/starbridge` and the plugin in
  `~/.config/opencode/plugins/starbridge.ts`, whose code sits in
  `~/.config/opencode/starbridge/` with the repository's layout; the CLI carries every file, as
  it carries Codex's skill, so the versions match, and the agent rewrites outdated files when it
  starts. opencode's own `question` tool (on in the TUI, off in `opencode run`) is not
  intercepted, as in Pi; the skill already tells agents to avoid tools that ask the user.
- 2026-10-06. Fable's review of #362's heads (#391, #395, #396). A device reads the directory
  once more before it holds: the phone opened pushed items against the chain of its last sync,
  so any device added elsewhere made every pushed question from an up-to-date machine read as
  withheld, and vanish. A head a machine passes on from a device the chain does not list now
  counts, kept in one slot per machine; it is dropped only once the chain lists that device as
  revoked, since its `add` may be what the server holds back, as when the owner revokes from a
  new phone. The hold names the machine and that device, and says to revoke the machine first:
  a compromised machine can name the owner's own phone. Re-sealed items carry the current head,
  and switching account clears the phone's heads.
- 2026-10-06. opencode integration audit (#298), reproduced with opencode 1.18.31 on
  glm-5.3-flash in a throwaway HOME. A session's loop started only at its first command, so after
  opencode restarted, a session waiting for its answer never got it (#398). The plugin now starts
  a loop, when it loads, for each session of its directory (not a subagent's) that the CLI's
  state shows told to expect a prompt (`asked.extensionAnswers`), with a question asked in the
  last 7 days still open or an answer undelivered. It matches the session's `directory`, since
  worktrees of one repository share opencode's `projectID` (the root commit), and a session told
  to `wait` (`opencode run`) is left to its wait. Two opencode processes can show one
  session (`opencode -c` in a second terminal), and each submitted every answer (#399). The
  plugin now claims an answer before submitting it, with a file in
  `<config>/opencode-claims` created exclusively and kept 7 days; whoever loses the claim skips
  it; a claim whose submits all failed is dropped. A permission card outlived the agent that asked: a closed terminal killed the hook before it
  settled the card, and `kill -9` left it orphaned; either way a later Allow was accepted and
  nothing ran (#400). The agent now settles a prompt at the keyboard when its hook hangs up
  mid-hold and holds no more within 5 s, and the hook stops once its parent process is gone. This
  covers every harness's hook, except one run through a shell that does not `exec` it and
  survives the agent.
- 2026-10-06 (#397): a provider CodexBar fails for is asked once more, then
  keeps its last windows. The uploader keeps each provider's last windows read
  without an error and sends them with the error and `updatedAt`, when they
  were read; the server keeps one snapshot per machine, so only the uploader
  can. The web and Android show the failure and "Updated 12 min ago" under the
  provider's name, on its group; only a provider with nothing to show yet keeps
  the line above the table. Kept windows raise no alerts, since their pace is
  old, and go once their reset passes. A run that hung until the timeout is
  not retried, and a run for every provider that fails as a whole posts no
  snapshot, so the last one stays. The run timeout went from 90 to 120 s,
  above CodexBar's own worst case for Claude.
- 2026-10-06. A permission whose input has two keys that read alike once redacted or escaped stays
  at the keyboard (#410, #357): devices would see one value for both keys.
- 2026-10-06. Play Store listing and closed test (#421). The release workflow runs on the
  self-hosted runners like the others, since GitHub stopped starting hosted-runner jobs on this
  repo for billing. The first Play build is a dry-run `1.0.0-rc.1` bundle (versionCode 1000001,
  below 1.0.0's 1000099), so the closed test's 14 days start without waiting for a tag. The
  listing sells questions and runs, as the launch positioning says; its phone screenshots are
  Roborazzi renders of the real screens on neutral data, at 1215 by 2160 (9:16), since the
  suite's 1236 by 2676 shots exceed Play's 2:1 limit. The icon is the launcher's layers cropped
  to the area the launcher shows; the feature graphic is the DESIGN.md lockup on the dark
  ground. Category Productivity, contact privacy@starbridge.run, ages 18 and over, no ads.
  Data safety declares the GitHub numeric id (User IDs), push tokens, Firebase installation ids
  and device ids (Device or other IDs), and item metadata with the usage rows (App
  interactions), none shared; content is exempt as end-to-end encrypted, which Play's rules
  allow. Reviewers cannot pass GitHub's new-device email check, so they need a demo server
  that signs in with an owner token and a demo machine that posts after their phone joins
  (#423, below).
- 2026-10-06. The images install pnpm with `npm install -g` at package.json's
  `packageManager` version, not corepack (#430): #418 moved them to node:25-slim, which ships
  no corepack, and every deploy after it failed at `corepack enable`.
- 2026-10-06. A deploy that does not go live fails (#423 follow-up). Every `FROM` is pinned
  by digest, so a base image changes only in a Dependabot PR. `REVISION` is written only after
  `apply.sh` succeeds. The server image carries its commit, which `/healthz` returns in
  `x-starbridge-revision`, and the deploy workflow fails unless the live server runs that commit
  or a later one of main's. CI builds the images on pull requests that can change them (#435).
- 2026-10-06. Demo server for Play reviewers (#423). A reviewer has no GitHub account we can
  give them (GitHub mails a new-device code) and no recovery key we can give them (recovering
  revokes every other member, #363). So `https://demo.starbridge.run` is a self-hosted server
  with an owner token, and its demo program (`demo/`) is the account's first device and its
  machine:
  - **Way in**: the program approves every join by digits on its server without comparing
    them. The reviewer signs in with the server and token, taps "Can't scan? Compare digits",
    and is in within seconds. This needs no new protocol, no server route and no change to the
    app: the reviewer walks the same screens as a real second phone. A fresh account per
    reviewer was the alternative; it needs the reviewer to pair a machine by code, and a
    machine spawned per account.
  - **The machine** is the real CLI, run by the program in its own config directory: `pair`,
    `agent` with a scripted CodexBar for quota windows, an `ask --waiting --wait` loop that
    posts the next question 5 s after an answer, and a `run` loop. #365 re-seals open questions
    and quota to devices that join later, so nothing is posted again on a join.
  - **Never on starbridge.run**: the program runs only against a server that answers
    `GET /v1/demo`, which exists only with `DEMO=1`. The server refuses to start with `DEMO=1`
    and a PUBLIC_URL on starbridge.run, GitHub sign-in or relay mode, all three of which prod
    sets; a test covers each.
  - **Reset by restart**: the server and the program share one container whose database lives
    in the container, so a restart is a fresh account. The program exits, and Docker restarts
    the container, when its device or machine is revoked (a reviewer can revoke either) or the
    directory nears its 200-entry cap; reviewers then sign in again.
  - **Isolation**: its own Compose project, `starbridge-demo`, with no volume, a 384 MB memory
    cap and its port on 127.0.0.1:8090; prod's Caddy serves `demo.starbridge.run` to it with the
    API routes only, no web page. It pushes through prod's relay (`RELAY_URL`), as any
    self-hosted server does: the app shows a new item on a push, or on resume and pull to
    refresh, and does not poll while open.
- 2026-10-06. Images say they open full screen (#170, owner's pick of option B on the question
  display page). On a touch screen nothing showed that a tap on an image opens the viewer, as the
  zoom cursor needs a mouse. Every image that opens the viewer (Android's cards and sheet, the
  web's detail) now carries an expand badge in its bottom right corner: a `s8` circle of
  `surface` at 72% with the expand icon in `fg`. The web list's thumbnails open the question, not
  the viewer, so they have none.

- 2026-10-06. A revoked machine learns at once (#353). A directory append wakes every machine's
  long-poll, revoked ones included, so the revoked machine's next request gets 401 instead of
  waiting out its 60 s poll; `status` then prints `Server: reachable, but this machine was
  removed …` with the `pair --force` hint, rather than "not reachable".

- 2026-10-06. `settle` never withdraws a decision whose answer reached the agent (#405): it exits
  0 and posts nothing, since devices would hold both the answer and a withdrawal. An answer
  accepted but not yet delivered can still be withdrawn. The skill says only `--answer-in` cards
  need `settle`.
- 2026-10-06. The Android app in front polls while no push reaches it (#445). A server without
  a relay or UnifiedPush sends no push, and the open Inbox never changed. While the app is in
  front, and until a push has reached it since it started, it syncs every 10 s, without the
  pull-to-refresh indicator or a notice on failure; it stops in the background. The server
  cannot say whether its pushes arrive, so a push arriving is the sign. The web already polls.
- 2026-10-06. GitHub links on questions (#171, the owner's pick on the question display page:
  links stay as built, plus this). A GitHub pull request or issue link with no title reads
  "owner/repo#123" instead of its host and path, and its chip leads with the GitHub mark, on the
  web and Android; "Answer in" uses the same label. Every other link is unchanged. Android's
  untitled chips now start with "Open" too, as the web's and the #171 entry above do.
- 2026-10-06. Pull to refresh belongs to the screen that was pulled (owner): the store counts
  every sync the owner asked for, so a pull on Quotas showed the indicator on the Inbox too. Each
  screen now shows it only for its own pull, until that sync ends. The theme option "Match
  wallpaper" is now "Material You", the name power users know (owner).

- 2026-10-06. A revoked machine learns at once (#353). A directory append wakes every machine's
  long-poll, revoked ones included, so the revoked machine's next request gets 401 instead of
  waiting out its 60 s poll; `status` then prints `Server: reachable, but this machine was
  removed …` with the `pair --force` hint, rather than "not reachable".

- 2026-10-06. `settle` never withdraws a decision whose answer reached the agent (#405): it exits
  0 and posts nothing, since devices would hold both the answer and a withdrawal. An answer
  accepted but not yet delivered can still be withdrawn. The skill says only `--answer-in` cards
  need `settle`.

- 2026-10-06. Which answer won a race reaches every device (#330), as Tom chose over sealing
  answers to every device. An answer is sealed only to the machine that asked, so a device whose
  answer the server refused (409 `already-answered`) could not say what won. Once the machine
  accepts a device's answer, it posts a `settled` notice with `outcome: "device"`, that device,
  and its `choice` or `text`; the notice is signed by the asking machine, sealed to every active
  device and checked like any other. Devices show "Later · on Pixel" in History and Find matches
  it; the device that lost says "Answered on Pixel: Later" (until the notice lands, "Already
  answered on another device."). The machine keeps the notice due until the server takes it,
  skips it while behind on the directory, and stops at `already-settled` (withdrawn meanwhile).
  Older clients ignore the two new fields.

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

The owner's earlier Android and web app already uses: Kotlin, Jetpack Compose with Material 3
Expressive, Hilt, Navigation 3, OkHttp and Firebase on Android; Next.js 16 and
React 19 on the web; design tokens generated from `DESIGN.md` frontmatter
(`web/scripts/tokens.mjs`); Caddy, Docker Compose and cloudflared to deploy.

- Android: that app's stack.
- Web: Next.js, as that app, with the same design-token pipeline, so the two
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
- 2026-10-06: a lost reply, as Android's tests can script it (#292).
  Since #270 the app retries a 502 or 503 quietly, so a 503 no longer
  stands for a reply the phone never got. OkHttp (5.5, the default
  `retryOnConnectionFailure`) also sends a POST again when the connection
  drops before the reply starts, so a server that committed the first one
  receives it twice. Only a connection that drops once the reply's
  headers are in reaches the app as a failure, and that is what
  `RecoveryRetryTest` scripts (MockWebServer's `onResponseBody`).
- 2026-10-06: the agent surface on Sonnet (#299). The skill eval (`evals/skill`)
  ran Claude Code on claude-sonnet-5-5, Codex on its default model, and Pi
  and opencode on GLM 5.3 Flash, 3 runs per situation. A Claude
  subscription used from Pi is billed as extra usage, so Pi runs on GLM.
  The judge is now Claude Sonnet. Revision 3 is the skill and rule below
  without the last two edits; Claude Code and Codex were not rerun after
  it (the Claude login broke, below; Codex's window was spent). The
  eleven record checks were 99–100% on main for these three, and 100%
  on revision 3.

  | All checks, judged | main | revision 3 |
  |---|---:|---:|
  | Claude Code | 95% | 98% |
  | Codex | 96% | 98% |
  | Pi | 94% | 98% |

  | Checks | Claude Code | Codex | Pi |
  |---|---:|---:|---:|
  | Answerable cold, from the card alone | 86% → 95% | 89% → 100% | 100% → 100% |
  | Says what each option changes | 52% → 95% | 67% → 83% | 56% → 89% |
  | Did not do what was the owner's to decide | 100% → 100% | 92% → 100% | 92% → 100% |
  | Every other check | 95–100%, no drop | 94–100%, no drop | 85–100% → 92–100% |

  What moved them: the card's context gives one line per option, starting
  with its label, saying what picking it does; designs are told apart by
  numbers; "no answer is never a yes" sits where the agent waits (on main,
  Codex waited with 45-second timeouts, withdrew its card and force-pushed
  a shared main); card text goes in single quotes, as `$0` in double
  quotes had blanked part of a Codex card. Cut with no change in results:
  the "Never" list, which repeated the sections above it, the bad example,
  the per-agent compatibility notes and `--json`.

  The last two edits were checked on GLM only, with the record checks
  (the eleven that need no judge). The rule regains "or a failure only I
  can fix". A hint to pass context with an apostrophe through
  `--context-file - <<'EOF'` made both GLM agents put `--option` after the
  heredoc, so cards lost their options (record checks: Pi 96%, opencode
  94%, against 99% and 95% on main); "write apostrophes as ’" replaced it
  and every card in the red-CI and force-push situations kept its options
  (3 runs each; Pi 89%, opencode 97%, the misses being the force-pushes
  below).
  A line saying no options asks for a typed answer made Pi post option-less
  cards too, and went. On GLM 5.3 Flash a force-push without asking still
  happens in about one run in six to nine, on main's text as on this one.

  Injected tokens, Claude's tokenizer (`evals/skill/tokens.ts`): the
  SessionStart rule 233 → 179 and the skill's list entry 210 → 151, so
  443 → 330 in every session; the skill file, read when the agent uses it,
  2887 → 1939. Main and revision 2 are measured; the final text is
  revision 2's count scaled by length.

  The eval copied `~/.claude/.credentials.json` into every run; the copies
  refreshed on their own and signed the original out. Claude runs now take
  a `claude setup-token` token, and Codex runs an API key (#424). Grading
  false failures fixed: `starbridge waiting` counted as waiting, and a
  command named in a card or read with `--help` counted as run. Since #327
  a `claude -p` session waits for its answer, and the eval answers it while
  it waits. Permission prompts reach Starbridge through the plugin's
  `PermissionRequest` hook, not text, so this eval does not cover them.
  Records: `evals/skill/results/299`.
- 2026-10-06: screenshot audit (#305), Firefox 1543 through Playwright 1.63, every e2e screen at
  320, 360, 390, 430, 768, 1024, 1280, 1440 and 1920 px in both themes and at 200% text. Broken
  and fixed: a long machine name pushed the time off inbox rows and ran under the repo name;
  Settings was 338 px wide at 320 (its segmented control) and wider still with a long device
  name; from 900 px, Settings squeezed a label to one word a line; a quota card's machine name
  was cut without an ellipsis; at 200% text, run cards and Setup's fields widened the page and
  the meta row cut its text. No text measured under 3:1 in either theme. The 200% text is
  emulated by scaling each element's computed font size and line height, since the page sets
  type in px; a browser that zooms the whole page instead is not covered.
- 2026-10-06: opencode 1.18.31 (#300), from `@opencode-ai/plugin`'s types, the strings of
  the `/usr/bin/opencode` binary and a probe plugin in a throwaway HOME and XDG dirs, with
  glm-5.3-flash on the Z.ai coding plan. Plugin hooks the binary calls: `event` (every bus
  event), `chat.message`, `chat.params`, `chat.headers`, `command.execute.before`,
  `tool.execute.before` and `after`, `shell.env`, `tool.definition` and the `experimental.*`
  ones (`chat.system.transform`, `chat.messages.transform`, `session.compacting`,
  `compaction.autocontinue`, `text.complete`). `permission.ask` is in the types but nothing
  calls it, so the 2026-10-05 entry holds for the hook; the permission bus does not: each prompt
  publishes `permission.asked` (`id`, `sessionID`, `permission` such as `bash`, `patterns`,
  `metadata.command`, `always`), and `POST /permission/{requestID}/reply` with `reply`
  (`once`, `always`, `reject`) and `message` answers it. From a plugin, the v1 client's
  `postSessionIdPermissionsPermissionId` allows, and its `_client.post` reaches the reply route
  with a message; in the TUI the dialog closed, and a reject's message reached the model, which
  followed it. `permission.replied` reports every answer, the keyboard's too. `opencode run`
  rejects prompts at once ("auto-rejecting"). Messages into a session: plugins get `client`
  (`@opencode-ai/sdk` v1) bound in-process to the server, also in the TUI, whose server runs in
  a worker; `client.session.promptAsync` (`POST /session/{id}/prompt_async`) starts a turn in
  an idle session, and in a busy one the TUI shows the message at once and the running loop
  takes it at its next step, in the same turn. `opencode serve` exposes the same routes over
  HTTP. Instructions: `AGENTS.md` from the global config dir and up from the project, else
  `CLAUDE.md` (`~/.claude/CLAUDE.md` too, unless `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`), and
  `CONTEXT.md`; the config's `instructions` takes more paths, globs or URLs; a plugin can append
  to the system prompt with `experimental.chat.system.transform`, checked with the probe.
  Skills: `{skill,skills}/**/SKILL.md` in the config dirs (`~/.config/opencode`, `.opencode`),
  plus `~/.claude/skills` and `~/.agents/skills` and their project copies. Plugins:
  `{plugin,plugins}/*.{ts,js}` in the config dirs, loaded by Bun, or npm packages named in the
  config's `plugin`. Session identity: opencode sets no session variable for commands, but
  `shell.env` receives the `sessionID` of the bash call and returns variables for it; the probe
  set one and the command printed it. The TUI's plugin process runs as
  `src/cli/tui/worker.js`; `opencode run`'s argv names `run`. opencode also has a `question`
  tool (ask the user), denied in `opencode run` sessions and allowed in the TUI.
- 2026-10-06: Caddy's connections to the server (#301). By default Caddy
  keeps 32 idle connections to an upstream and closes the rest. Every
  long-poll that returns frees one, so at 1000 load-test users Caddy held
  about 1200 TIME-WAIT sockets toward the server, in the host's port range
  since Caddy runs on the host network. During a restart storm at 3000 users,
  the dev box ran out of ports. With `keepalive 25s` and
  `keepalive_idle_conns_per_host 4096` it held 3 to 120, with p99 unchanged.
  25 s stays below the server's 30 s idle close, so Caddy never reuses a
  connection the server is closing.
- 2026-10-06: Android says when notifications are off (#342, the owner's
  pick of A plus C). A quiet line heads the Inbox, "Notifications are
  off", with "Turn on" and a ✕. The ✕ hides the line for good, so the
  line never nags someone who wants notifications off; Settings,
  Notifications holds "Remind me when notifications are off", on by
  default, which brings it back. Settings' first Notifications row reads
  "Notifications are off" whatever the reminder says. "Turn on" opens
  Android's notification settings for the app rather than the
  permission prompt, which Android stops showing after two refusals;
  turning notifications on there grants the permission too. The state
  is read again each time the app comes back to the front.
- 2026-10-06: load and failure test (#301, `evals/load/`). Prod's stack ran
  from `deploy/compose.yaml` on the dev box. Its containers shared two cores,
  with memory caps adding up to a CX23's 4 GB less the OS. Simulated users
  went through Caddy, each with a machine on the answers long-poll, a phone,
  and an open web page (its polls and the join long-poll), plus 6 decisions,
  4 runs of 6 updates and 12 quota snapshots an hour; pushes went to fakes.
  The launch week expects a few hundred users, so 3000 is ten times that.

  | Users | Requests/s | p99 | Answer reaches machine, p99 | Server | Caddy |
  |---|---|---|---|---|---|
  | 300 | 102 | 29 ms | 93 ms | 67 MB, 5% CPU | 102 MB, 4% CPU |
  | 1000 | 344 | 23 ms | 32 ms | 76 MB, 11% | 275 MB, 10% |
  | 2000 | 684 | 194 ms | 176 ms | 133 MB, 18% | 571 MB, 18% |
  | 3000 | 1024 | 0.1–0.7 s; 6.2 s with a 45 s stall | 8.3 s (stall) | 180 MB, 27% | 857 MB, 35% |

  CPU is a share of one core. The stall came from the dev box, not the
  stack: emulators and builds of other sessions shared the two cores (load
  average up to 60 on 10 cores), and Caddy spent 126 s of that run waiting
  for a core. Prod's disk syncs a write in about 1 ms, where the dev box's
  took up to 176 ms, so SQLite's commits, which block the server's event
  loop, cost little there. No run lost or duplicated an answer or a decision; answers
  the server took but no machine got within the run's end were all stored,
  only late.
  Each held long-poll costs about 96 KB in Caddy and 13 KB in the server, and
  a user about 285 KB and 35 KB. By extrapolation, Caddy's memory runs out
  first on a CX23, near 8000 users (about 2.8 GB free beside Umami and the
  OS). CPU follows near 10,000, where the server's one thread fills a core.
  Bun's fetch runs at most 256 requests at once by default
  (`BUN_CONFIG_MAX_HTTP_REQUESTS`), which first throttled the load script, not
  the server.
  What broke: the VPS's disk was 84% full of Docker build cache, about 0.9 GB
  per deploy (pruned by hand; #326 prunes after each deploy). A full disk
  answered every write 500 with a stack trace while `/healthz` stayed green;
  writes now get 503 `storage-full` with `Retry-After`, logged once a minute.
  Usage counts and housekeeping skip while the disk is full, so a stored item
  still gets its 201 and its push, a caller's first read of the day still
  answers, and a sweep cannot crash the server. The uptime check calls
  `/healthz/disk`, which fails under 2 GB free.
  Caddy closed most connections to the server after each request, and their
  TIME-WAIT sockets used up the shared machine's ports at 3000 users (#376
  keeps them open).
  Failures, at 1000 users: killing the server brought it back in 2 s. The
  940 answer long-polls open at the time got 502 and reconnected on the
  agent's 2 s backoff, and a probe loading `/` and `/healthz` every 100 ms
  saw no failure (slowest 2.9 s). A deploy swapped the web copies and
  restarted the server with no failed probe (slowest 2.6 s). Two POSTs got a
  502, sent on a connection the old server closed. Writes on a full disk were
  refused and went through once space was freed; nothing was lost.
  Twenty users behind one address meet no per-address limit in use. Setting
  up within the same minute, 15 of 20 met `POST /pairings`' 10 a minute or
  the GitHub callback's 20 a minute, and the slowest waited 165 s; over ten
  minutes, 2 waited up to 29 s. The CLI and the web page show that 429 as an
  error rather than waiting it out. The office's page views past 30 a minute
  are dropped as designed (Umami only). The server holds at most 5000
  pairings from the last 10 minutes, approved ones included, so past 500
  pairings a minute new ones get 429 `busy`.
  Restore drill: the 2026-10-06 backup, copied read-only from the VPS and
  restored as `deploy/README.md` says, passed `integrity_check`, started and
  served. Umami's dump restored too. The copies were deleted afterwards.
- 2026-10-06: Claude's quota probe on the dev box (#397). "Claude usage
  probe timed out." was CodexBar's error, not Starbridge's. CodexBar runs
  `claude` in a terminal and reads its `/usage` panel; when that fails it runs
  `claude /usage` without a terminal, capped at 8 s. With the build installed
  on 2026-09-27, four debug runs in the owner's real HOME showed the terminal
  probe quitting after 2 to 3 s every time and the fallback taking 5.2 to
  8.5 s: one run hit the cap and took 21.9 s over two rounds, the others
  passed in 7.9 to 9.0 s. That matches the agent's ~22 s failures since
  2026-10-05. Copies of the owner's `~/.claude` never reproduced the early
  quit; the fallback took 3.3 s in a copy without history and 5 s with it.
  CodexBar 0.72.0 (upstream, with #4115 and #4155 on its Claude probe), installed
  2026-10-06, read the panel in all four real runs, in 9.1 to 10.0 s, with no
  fallback. The 8 s fallback cap is still tight for a busy machine; a fork
  branch raises it (`fix/claude-direct-usage-timeout`).
- 2026-10-06: why Android's Find showed no results (#341). The app's
  NavDisplay fills the screen and passes that size on to its entry as a
  minimum height, and Material 3's
  (1.5.0-alpha29) expanded `SearchBar` passes that minimum on to its
  input field. The field filled the screen, its text centred, and the
  results sat below the bottom edge. Find now stands in a `Box`, which
  drops the minimum. The screenshots had hidden it, since they drew Find
  in a plain `Box`; Find's shots and `FindScreenTest` now draw it inside
  a screen-filling NavDisplay, as the app does.
