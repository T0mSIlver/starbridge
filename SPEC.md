# Starbridge spec

What Starbridge does and why, by area. Most rules name the issue where they were decided, which
holds the discussion. `PROTOCOL.md` has the wire format and `DESIGN.md` the look; this file covers
what they don't. A change that makes or changes a decision edits its section here and replaces
what it supersedes.

## What it is

One person supervises their coding agents from an Android app and a web page with the same
features:

- **Questions.** An agent asks for a decision that is the owner's; the owner answers with one tap
  on the phone or in a browser, and the answer reaches the waiting session as its next prompt.
- **Runs.** Anything an agent starts that the owner wants to follow because it affects them: heavy
  work on their machine, a build, a release, an eval, a test that takes over the screen. Its
  progress stays on the lock screen until it passes or fails.
- **Permission prompts**, opt-in: allow or deny an agent's tool call from the devices.
- **Quotas**: what's left on each AI plan, read from CodexBar, with optional alerts.

The server at starbridge.run is free; anyone can self-host the same image. MIT licence.

### Principles

- **Agents never answer for the owner** (#122). A question has no default time, and nothing
  happens when nobody answers. A blocked agent works on something else, builds both options when
  that is cheap and asks which to keep, or waits.
- **Build on the harnesses, don't replace them** (#58). Session controls were dropped: a list of
  20 or more live sessions costs a write per change, for a setting only an orchestrator needs.
- **A question stands alone.** The owner reads it on a lock screen, away from the code, so it
  carries everything needed to decide.
- **One question, one answer surface** (#62). A question is answered in Starbridge or on the page
  it names (`answerIn`), never both.
- **The server reads nothing.** Questions, answers, prompts, runs and quotas are end-to-end
  encrypted; only the owner's devices and machines hold keys.
- **No new cryptography.** Audited libraries only.
- **Web and Android have the same features.**
- **No client telemetry** (#140). The server counts only requests it handles anyway.

### Positioning

The landing page, docs, README and store listing sell questions and runs, each by why it matters
to the reader. The hero: "Know the moment your agent is stuck" (#448). Quotas get one line: users
don't launch agents from Starbridge, and the power users it targets don't check quotas by hand.
Alerts are opt-in, so copy never says they are on. Permission prompts are secondary and opt-in.
Copy says "on each machine that runs agents", never "on each machine" alone.

### Platforms

The web app ships first wherever it can: installed to the home screen on iOS (Web Push works for
home-screen web apps since iOS 16.4) and as an installed app on desktop browsers. Android is a
native app. No native iOS app until there is demand and a device to test on. A desktop app, if
one comes, is Tauri over Electron, to reuse the web code; a Mac surface may instead live in
CodexBar's menu bar, upstream.

The CLI runs on Linux, macOS and Windows (#552, decided 2026-10-06 for launch). On Windows,
CodexBar has no build, so a Windows machine uploads no quotas and setup says so; questions,
runs and permission prompts work as elsewhere. The CLI reads `Path` as `PATH`, takes `HOME` from
`USERPROFILE`, finds commands by `PATHEXT`, and starts an npm `.cmd` shim through cmd.exe with
every argument escaped as cross-spawn does it, so no argument runs as a command.

## Architecture

```
agent sessions --CLI--> starbridge agent (one per machine) --HTTPS--> server <-- web page
  ^ mod, plugin or extension:          runs CodexBar                    |
    answers come back as prompts                                       +--> push relay --> FCM --> Android
```

| Path | What |
|---|---|
| `packages/protocol` | zod schemas, signing and sealing on libsodium, quota pace and alerts, JSON test vectors the Kotlin client also passes |
| `server` | Hono on Bun with `bun:sqlite`, one Docker image; `RELAY_MODE` also makes it the push relay |
| `cli` | the `starbridge` command and `starbridge agent` |
| `plugin`, `mod` | Claude Code's two plugins: `starbridge` (skill and hooks) and `starbridge-mod`, split so that builds refusing mods keep the rest. `mod/pi` and `mod/opencode` hold the Pi extension and opencode plugin |
| `web` | Next.js; decrypts in the browser |
| `android` | Kotlin and Compose |
| `deploy` | the hosted instance |
| `demo` | the program behind the Play reviewers' demo server |
| `evals` | the skill eval and the load test |
| `docs` | pages served under `/docs` |

Why this stack: one TypeScript schema serves the server, CLI and mods, and Claude Code mods are
TypeScript already. Bun gives `bun build --compile` binaries; npm gets a Node 22+ bundle, so the
CLI uses no Bun global without a guard. SQLite is enough because the server stores ciphertext and
public keys only. Design tokens are generated from `DESIGN.md` to CSS and Kotlin, so both clients
share colours and type.

**CodexBar** (github.com/steipete/CodexBar) is read, never embedded. Its maintainers want
integrations beyond macOS to consume `codexbar usage --json` or `codexbar serve`, and declined a
stable snapshot interface, so the uploader reads its JSON and tolerates schema changes. CodexBar's
provider plugins add providers, not panels.

## Keys and trust

- **Libraries.** libsodium sealed boxes (`crypto_box_seal`) and Ed25519: libsodium.js on the web,
  Lazysodium on Android. On the web, sealed boxes open with WebCrypto's X25519 plus HSalsa20 from
  `@noble/ciphers` (audited), since libsodium.js's standard build lacks it. Not libsignal: AGPL,
  and its ratchets solve chat problems Starbridge does not have.
- **Members.** Every device (phone, browser) and machine (where agents run) makes an X25519 and an
  Ed25519 key pair. Private keys never leave it.
- **Sign, then seal.** A signature covers the JSON body text as sent, so nothing re-serializes
  JSON. Each sealed kind has one signing role (`ITEM_KINDS`).
- **The directory** is a hash chain (BLAKE2b) of signed entries that clients pin, so the server
  cannot add its own key or roll the chain back past what a client saw. The recovery key co-signs
  the first entry. Clients refuse a chain with an `op` they don't know rather than skip it, since
  skipping could keep a replaced key or a revoked device trusted: every client must update before
  anyone uses a new `op`.
- **Directory cap** (#260). From entry 200 the server refuses a device-signed `add`
  (`directory-full`) but always takes a revocation and up to 20 recovery entries, so a lost
  machine can still be revoked and an owner can still recover. Recovery entries have caps of
  their own, so the chain stays bounded. No compaction: a checkpoint would need a new trust rule for pins.
- **Pairing.** A pairing code carries an 80-bit secret the server never sees, which keys an HMAC
  on both pairing messages. A device signed in to the account can instead join by digits (a
  6-digit short authentication string with a commitment, as in ZRTP and Matrix SAS), by scanning a
  QR code, or through the link `starbridge pair` prints (#66). Both screens confirm the digits
  (#355): otherwise a server in the middle could forge an approval to the joining device. The CLI
  never joins by digits.
- **The recovery key** is a random 16-byte seed shown as 28 Crockford base32 characters with a
  12-bit check, in seven groups of four, read in any case, with or without dashes (#199). 128 bits
  is Ed25519's own security level; the seed is random, so it needs no slow key derivation:
  BLAKE2b-256 of `"starbridge/v1/recovery-seed" NUL seed` stretches it to an Ed25519 seed. It is not
  shown as words: a new site that shows 12 words and later asks for them back looks like
  seed-phrase phishing, and Chrome flagged starbridge.run for it. No page says "seed" or "phrase".
- **The first entry is posted only once the owner confirms the key is saved** (#328, #370). The web
  never stores the key; Android keeps the seed in its encrypted store until that confirmation. A browser marks its device posted before it posts the genesis, so an empty
  directory after that is the server's doing, and the keys stay (#371).
- **Replacing the recovery key** (#348) takes two entries: `recovery` proposes a key, signed by a
  device and the new key; `recovery-confirm` makes it current, signed by the current key and naming
  the key it confirms. It always needs the current key: letting a second device confirm would let
  a stolen phone, which can add a device of its own, take the key over. An owner who lost the key
  keeps their devices and has no key.
- **Recovering** writes a `recover` entry that adds the device and revokes every other member,
  machines included (#363, #364). A recovering device holds no pin, so a server could serve it a
  chain cut short of a revocation; revoking everyone means no fork keeps a revoked member. The
  owner then pairs what they still have again. The recovery key never signs a `revoke` or a plain
  `add`.
- **Withheld revocations** (#280, #362). A member cannot tell a current directory from one the
  server cut short, so detection is on contact, both ways. Devices sign the directory head they
  hold into each answer (`dir`); a machine refuses every device answer while an active device has
  signed a head its chain lacks. Machines sign `dir` into every item; a device re-reads the
  directory, then holds every machine's items (shows none, notifies nothing, sends no answer)
  while an active machine has signed a head its chain lacks. A machine also passes on heads it
  got from devices. Such a head counts even when the chain doesn't list that device yet, until
  the chain shows the device revoked. The hold names the
  machine and the device and says to revoke the machine first, since a compromised machine can
  name the owner's own phone. Settings and revoking keep working. Closing the gap fully needs a
  channel the server does not carry.
- **Browser keys** (#8, #116, #274, #283, #354). Non-extractable WebCrypto keys in IndexedDB,
  read back once after writing, with raw libsodium keys where they don't return (WebKit reads an
  X25519 `CryptoKey` back as null). A join or recovery keeps its keys under `pending` until the
  directory lists them, and pins before it saves the device. With no pin, a browser trusts only a
  genesis its own device signed. A browser that signs in again binds the session to its device by
  signing a server nonce.
- **Revoked members.** Only the verified chain revokes a browser (#310): a 401 `revoked` is
  unsigned, so the page keeps its keys. Once the chain shows it revoked, the browser deletes its
  keys, answers and push subscription, keeps the pin, and says which device removed it (#343).
  Android wipes only on a verified chain that revokes the phone (#44). A revoked machine gets 401
  on its next long-poll (#353). A machine drops the answers of a device the chain revokes that its
  sessions have not taken yet, on every poll and before `answers` or `wait` hands one out, against
  a fresh directory or, out of reach of the server, the saved one (#491). The server holds that
  decision answered, so the machine closes it: `wait` says its answer came from a device removed
  since, and `settle` posts nothing (#515). The asking session gets no line, so an agent told its
  answer comes back as a prompt is not told.
- **Android keys** (#9) sit in files wrapped by a Keystore AES key usable while the screen is
  locked, so lock-screen buttons can sign. Signing out revokes the phone unless it is the last
  device.
- **Versions** (#468, #469, #478, #551). 0.1.0, the first public release, is the compatibility
  floor, so nothing carries code for clients before it: `ask` refuses `--default` and `--default-at` rather than ignoring them, and
  clients, setup and the CLI dropped what served earlier releases. Later compatibility branches
  name the minimum client release that retires them (`// until min cli >= 1.2`). An algorithm
  changes only with a new protocol version (`v: 2`, `starbridge/v2/...`, `/v2` routes) and members
  re-pair; keys change only by revoke and add.
- **Readers keep what newer senders add** (#472; PROTOCOL.md, "What a reader keeps"). A string a
  client only displays reads as its neutral case when unknown: no machine kind, no outcome,
  `working`, no progress, pace `unknown`; an alert of an unknown kind is left out. Readers do this
  on the raw body before the schema check (`readable`, with a Kotlin twin), so the schemas stay
  strict for writers: a missing field or a value of another type still refuses the item on every
  client. Values that gate behaviour stay closed. Reader-side content limits stay until the
  screens cope with longer text. Android keeps a machine's last good quota snapshot when a new
  one fails to open. Android re-checks Allow when a notification's button is tapped, which is not
  about old clients: the owner may turn off sending unseen commands after the post.
- **Signed text is the record** (#476). Android keeps each item's body as the text its machine
  signed and parses it on read; the parsed body is a cache, never written back, so a field a later
  app learns is already in what the phone kept, and nothing re-reads open questions. An item
  whose text no longer parses is dropped at load. The web stores no bodies; the CLI stores only
  bodies it wrote.
- **Nulls** (#505). A `null` in a field the schema does not make nullable refuses the item on every
  client, as zod does. Android, whose classes read null as absent, checks each declared field
  after `readable()` and ignores fields it does not declare, as zod strips them.
- **Local state carries its format** (#473), and a file a client cannot read is kept, never
  silently replaced. The CLI writes `v: 1` into `machine.json`, `directory.json` (`{v, entries}`),
  `agent.json` and `state.json`; a file without `v` is format 1, and one that is not JSON, not an
  object or newer stops the command with its path and what to do. Android writes `v` into
  `state.bin` and `secrets.bin` and a format byte ahead of the Keystore blob; the two describe one
  device, so when either cannot be read both move to `<name>.unreadable-<time>` and the app starts
  signed out and says so. Quota settings write their defaults, so a later default never changes a
  saved choice. The web writes `v` into its localStorage values and leaves a newer format alone; a
  damaged one is replaced at the next change, since it holds only display choices. IndexedDB's own
  version is the records' format, and sign-out removes every record kind of the account.
- **Old clients** (#468). Every client names its release in `starbridge-client:
  <name>/<version>` (`cli`, `android`, `web`, `mod`; MAJOR.MINOR.PATCH). The server refuses
  releases below `MINIMUM_RELEASES` in `server/src/clients.ts` (empty at launch; a pre-release
  counts below its release) with 426 `client-too-old`, and serves a request without the header,
  so curl and scripts keep working. The CLI then says to run `starbridge update` and exits 1; the
  web shows one "Starbridge was updated" screen with Reload; Android shows an error that names
  Google Play. Usage counts each member's first release of the day once
  (`active.clients.<name>.<major>.<minor>`), so made-up versions add one row a day.

## Sign-in

- The hosted server signs in with GitHub; a self-hosted server with `OWNER_TOKEN`.
- Android (#34, #527): the app signs in with PKCE, and GitHub binds its code to the app's
  challenge, so only the app holding the verifier can trade the code, whoever catches the
  redirect. Known gap: a hostile app can start its own sign-in, and if GitHub skips the consent
  screen it gets a session.
- On starbridge.run, GitHub redirects the app's sign-in to `/v1/auth/github/callback/app`, an
  App Link the app catches (#527). The installed web app's scope is the whole origin, so Chrome
  handed it the page's callback when no other app claimed that; where both claim a URL, Chrome
  opens the verified app. The page's sign-ins keep `/v1/auth/github/callback`, which the app does
  not claim, so they stay in the web app.
- When the browser gets the app's redirect (app missing, verification failed, an older app), the
  server passes GitHub's code on to `APP_REDIRECT_URI`: on starbridge.run the App Link
  `https://starbridge.run/app/auth`, whose page has an "Open Starbridge" button to
  `starbridge://auth`. Chrome asks "Continue to Starbridge?" before following a `starbridge://`
  redirect that no tap started; after a tap it does not. Self-hosted servers keep
  `starbridge://auth`, since the APK can bind only starbridge.run.
- `assetlinks.json` lists the release key, which Play App Signing also uses, and the dev box's
  debug key, so dogfood builds verify too. That key never leaves the dev box, and a caught code is
  useless without the verifier.

## Server

- **Bounds** (#65, #260), sized for an orchestrator with 10 sessions asking a few hundred
  questions a day: every route that stores something has a cap or retention, and every write that
  grows it a rate limit. Answered questions and their answers are kept 7 days, unanswered ones and
  quota snapshots 30. Per account: 10000 questions, 10000 permission prompts, 128 MB, each item
  charged its boxes plus 512 bytes per row. The numbers live in `server/src/limits.ts` and
  PROTOCOL.md, "Limits". A post reads counts from a totals table kept by triggers.
- **Retention comes from `ITEM_KINDS`** (#477). Each kind names its `keep`: a day, a week or a
  month after it was received, answered or left unanswered; `withRe` (it goes with the item it
  refers to); `fromActive` (it goes when its machine is revoked). The hourly sweep builds its
  deletes from that table, and a kind without `keep` fails typecheck, so no kind is stored and
  never dropped. The periods are server limits, so tests and self-hosters set their length.
- **Sizes** (#170). A question's boxes may hold 2 MB together and one image's base64url 512 KB; the
  request body limit is 3 MB. Each box carries the whole body, so the cap must fit every device's
  copy.
- **Runs** are one item the machine re-posts under its id; the server keeps the latest, at most
  500 per account, for a day after the last update.
- **Permission answers** are refused 10 minutes after the prompt arrived, since the server cannot
  read its `expiresAt`.
- **Pairings** (#309). Each address may hold 20 unapproved pairings (IPv6 counted per /48 on this
  route), on top of 10 a minute; the server-wide cap of 20000 is the disk bound. Mobile carriers
  that hand out /64s from one /48 share 20, a smaller blast radius than the whole server.
- **Long-polls** identify their caller again after the wait and answer 401 if the session or token
  was revoked meanwhile (#260). A directory append ends every machine's answer long-poll, and the
  reply carries the directory's length (#158). On SIGTERM the server ends every long-poll as if
  its wait passed.
- **Re-sealing** (#340). Items are sealed to the devices in the directory when posted. When a
  device joins, the machine re-signs its open questions and prompts to the full recipient list and
  re-posts them (`reseal`). The server takes a re-post only from the machine that posted the item,
  only while it is open, keeps its arrival time and pushes only the new recipients. Nothing is
  re-sealed while the machine finds the directory behind. A re-post that fails is tried again on
  the next poll, prompts included: a prompt keeps the devices that hold it apart from those whose
  answers count.
- **Fresh quotas** (#158, #450). The local agent posts a snapshot once its directory holds a new device.
  `POST /quota/ask` wakes the machines and holds until each posted, up to 25 s, under the 30 s at
  which proxies cut long polls; 6 a minute per account, since each runs CodexBar on every machine.
- **Schema migrations** (#470). `PRAGMA user_version` counts the migrations a database has run;
  each runs in one transaction with its version. A server refuses a database newer than it knows,
  so a rollback past a migration fails at start instead of writing rows the newer schema misreads.
  Version 1 is the 0.1.0 schema with `IF NOT EXISTS`, so it adopts a database made before versions
  were counted. A migration changes the schema and never rewrites rows, to stay within the 30 s
  Caddy holds requests; backfills run in the hourly sweep. `apply.sh` backs the database up just
  before the new server starts and keeps the last five.
- **Full disk** (#301). Writes get 503 `storage-full` with `Retry-After`; usage counts and
  housekeeping skip, so a stored item still gets its push.
- **Usage counts** (#140). `server/src/usage.ts` counts requests the server handles anyway. During
  a day `usage_events` holds one row per event, with an account or member id only where a count is
  of distinct ones; each hour finished days fold into `usage_days` and their events are deleted, so
  no per-user row outlives its day. Read with `bun server.js usage [days]` inside the container.
  `/privacy` lists the counts.

## Push

- FCM goes through the relay, since its credentials belong to the app's Firebase project. Web Push
  goes through the relay only when a server has no VAPID keys; UnifiedPush always goes direct. The
  relay is open, rate-limited per IP, and pushes only ciphertext or ids. A push carries the
  device's ciphertext when it fits FCM's 4 KB, else the item id.
- Quota snapshots and runs skip Web Push: browsers drop subscriptions whose pushes show no
  notification (Firefox after 16). The web page polls them instead.
- Caps (#27, #36, #37): 10 subscriptions a device, 30 an account; 4 pushes in flight and 200
  waiting per account, 10 s each. A push connects to the exact address that passed the
  private-range check, and is sent only if its subscription and device are still active (#260).
- An Android app in front syncs every 10 s until a push has reached it (#445), since a server
  without a relay or UnifiedPush pushes nothing and cannot tell.

## Machines

- **The local agent**, `starbridge agent` (#68), one per machine as a user service (systemd or launchd), owns the
  keys and the server connection, uploads quotas, and routes answers, prompts and runs to sessions
  over HTTP on a unix socket (PROTOCOL.md, "Local agent API"). Every CLI command asks the local
  agent first and talks to the server itself when none listens or it answers 426; once it has
  answered it never falls back, so nothing posts twice. `wait` is the exception (#548): the agent
  marks an answer seen only for a client still listening, so when it restarts under a wait, the
  wait asks the new one, and after 30 s with no agent it waits at the server. Answers stay in the CLI's state file,
  so both paths share one store.
- **Files** in `~/.config/starbridge` (or `$XDG_CONFIG_HOME`, `$STARBRIDGE_CONFIG_DIR`): 0600 in a
  0700 directory. A `.lock` guards every read-modify-write (#33). A directory refresh keeps the
  longer of the fetched and saved chains, each required to extend the other's pin.
- **The socket** is bound under a 077 umask (#95). There is no peer uid check, since neither Bun
  nor Node exposes `SO_PEERCRED`. The local agent runs only the CodexBar binary its own config names,
  never a path a client sends.
- **Answers on the machine** (#260). A machine accepts an answer only from a device the question
  was sealed to, only while it is open, and for an `answerIn` question only a Done, when it asked
  for one (#539). A settled question's
  answer is never delivered, since a server could hold an answer back until the agent moved on.
- **Pairing a machine.** `pair` uses starbridge.run unless `--server` or `STARBRIDGE_SERVER` says
  otherwise (#154). `pair --force` keeps the machine's server and name (#245) and leaves the old
  pairing active, so Devices shows the added time on rows that share a name (#287). `pair` and
  `setup` guess `machineKind` (cloud, laptop with a battery, server with no display, else desktop);
  `config machine-kind` corrects it.
- **Setup** (`cli/src/setup/`; #68, #239, #245) installs CodexBar's latest release, taking the
  static musl build where the glibc one would not start. Only the repository is pinned, since
  CodexBar ships almost daily (#530): the tarball must match the `.sha256` of the same release,
  as Homebrew checks it, and `starbridge update` moves that install to the latest release too.
  `update --codexbar <version>` installs one release, for when the latest breaks; a broken
  CodexBar already shows as each provider's quota error, so there is no other rollback. A daily
  workflow installs the latest release and reads its output without credentials, and opens an
  issue when it breaks. A provider works when `usage
  --provider X` returns windows; CodexBar exits 1 with the reason in its JSON row, so setup reads
  the row. The unit runs the `starbridge` on the PATH when that is the running binary, since that
  path survives brew upgrades. Setup turns on plugin auto-update through `extraKnownMarketplaces`,
  installs the Claude Code plugins only from a marketplace whose source is this repository (#274),
  and offers, each after asking, Codex's skill, the Pi package and opencode's plugin and skill,
  from copies the CLI carries so versions match. The local agent rewrites outdated copies when
  it starts.
- **Files setup writes into other tools** (#474) start with one marker line, ``Written by
  starbridge <version>; `starbridge uninstall` removes it.``, in the file's comment syntax: the
  systemd unit, the launchd plist, the Codex rule, the opencode entry and the copied skills (a YAML
  comment first in the front matter). A file is Starbridge's only when it has the marker: setup
  replaces it when it differs from this release's, uninstall removes it, and any other file at
  those paths is left alone, even a skill named `starbridge`, which another skill manager may have
  installed (#538). An owner who
  deletes the line keeps the file. `starbridge update` runs the new binary's `setup --refresh`,
  which rewrites the marked files that differ and restarts the local agent; Homebrew and npm users
  run it after upgrading, and the local agent refreshes the skills and rule when it starts.
- **Allow rules** (#245, #322, #443, #488). So a new user's first question needs no prompt and no
  sandbox flag, setup allows `starbridge ask`, `waiting`, `working`, `wait` and `settle`: Claude
  Code allow rules, a Codex execpolicy file (`~/.codex/rules/starbridge.rules`) that runs them
  outside the sandbox, and for Pi the Starbridge link in pi-permission-system's `authorizerChain`
  plus its `skill` and `read` gates for the Starbridge skill, after the owner's own patterns since
  the last match wins. Pi gets no bash pattern, since none is safe there (Platform facts): the link
  allows a bash ask itself when the whole typed line, from the ask's "full command" evidence, is
  one of those commands with only words, flags, quoted strings and line-joining backslashes; an ask
  without evidence, or from a shell tool under another name, goes to the owner. The local agent
  removes the bash patterns older setups added, except a level other than `allow` the owner set,
  and reports them when the config has comments it cannot rewrite. `starbridge run` is left out,
  since the command it wraps is the agent's own. Uninstall removes exactly what setup added.
- **Docs** (#211) at `/docs` are the repository's Markdown files listed in `web/src/lib/docs.ts`,
  rendered by the web page. Links between them become `/docs` links; other relative links go to
  GitHub.
- **The CLI's agent-facing contract is stable from 0.1.0** (#475, #551): the commands, flags,
  output lines and exit codes under "What agents parse" in `cli/README.md`, pinned by
  `cli/test/contract.test.ts`. A release may add to it; changing or removing anything listed comes
  only after a release that deprecates it, since the plugins, the Pi extension and agents'
  instructions update apart from the CLI. `--json` always means an output format (`wait --json`); `ask` reads its input with
  `--input <path>`.
- **Install and update.** `https://starbridge.run/install.sh` is `cli/install.sh`, prerendered by
  the web page, so each deploy serves its own revision's script. It checks `SHA256SUMS` with
  minisign, or OpenSSL 3 when minisign is missing. `starbridge update` replaces script installs
  and points Homebrew and npm installs at their manager. Windows refuses to replace or delete a
  running `.exe` but lets it be renamed, so `update` moves it aside to `starbridge.exe.old` and
  the next update removes that; `uninstall` deletes the binary from a detached cmd.exe two seconds
  after it exits (#552).

## Harnesses

### How an answer comes back

An agent posts a question, keeps working and ends its turn; the answer arrives as a new prompt.
Where nothing can deliver a prompt, the agent runs `starbridge wait <id> --timeout 5m` before
ending its turn. `ask` prints which of the two applies (#203). A `wait` without an id, run in an
agent's session, takes only that session's answers (#324).

| Harness | Delivery |
|---|---|
| Claude Code, interactive | The mod (`mod/`) long-polls the local agent's socket in 25 s cycles and submits each answer with `$.prompt.submit` |
| `claude -p` | `wait`, since mods run only in interactive sessions (#321) |
| Codex TUI | The local agent runs `codex queue --thread <id>`; the message only says to run `starbridge wait <id>`, since other local users can read process arguments (#274). Retried each minute, 30 times |
| `codex exec` | `wait`: nothing runs a queued message once exec returns. The thread's rollout tells exec apart (#245) |
| Pi TUI and RPC | The Pi extension (`mod/pi`) calls `pi.sendUserMessage(text, { deliverAs: "followUp" })` (#232) |
| opencode TUI and `serve` | The opencode plugin (`mod/opencode`) calls `client.session.promptAsync`, one loop per session (#300) |
| `pi -p`, `opencode run`, subagents | `wait` |

- **The mod** (#7, #35, #48, #68). Why a mod and not Claude Code channels: channels need launch
  flags and an allowlist. A mod cannot listen on a port and its `$.http.fetch` aborts after 30 s,
  hence the short cycles. The CLI hands an answer again until the mod acks it, and the mod
  re-reads the session id before submitting, so an answer that arrives during `/clear` waits for
  the session that asked; `/resume` keeps polling under the resumed id. Without a local agent the mod
  falls back to polling through the CLI, and both paths share the set of submitted lines.
- **Which harness asked** (#319, #320). Harnesses pass their variables to processes they start, so
  `ask` takes Codex, Pi or opencode over Claude Code when both are set, unless Claude Code runs as `claude
  -p`, the only way Codex and Pi start it. A Codex sub-agent asks under its root thread, since
  `codex queue` refuses sub-agent threads.
- **Pi and opencode** append `plugin/hooks/rule.md` to the system prompt and run the mod's own
  answer loop (`agent.ts`, `poller.ts`, `switch.ts`). opencode gives commands no session id, so
  its plugin sets `STARBRIDGE_OPENCODE_SESSION` through `shell.env`. After opencode restarts, the
  plugin resumes the loops of sessions still expecting an answer (#398); two processes showing one
  session claim each answer with an exclusive file before submitting (#399). A loop confirms an
  answer only once opencode took it, and a claim never marked submitted, left by a process that
  died, is taken over after a minute.

### Skill and rule

- The `starbridge` plugin's `SessionStart` hook adds the rule as context, so setup edits no
  instruction file. Starbridge is how an agent reaches its user: a card for a decision that is
  theirs, a question before ending a turn on work that waits on them, `starbridge run` around commands
  that block them. Everything else the agent decides. It asks in the terminal only when
  `starbridge` fails (#121).
- A question answers cold: its options answer it, and its context runs two to five lines, the fact
  that forces the choice, then one line per option saying what it changes. Links and images only
  when they help; one question per card. The first option is
  the agent's default (#191).
- Agents also wrap, unasked, any command that blocks the owner or needs them at the machine, and
  always give a reason (#60).
- There is no Starbridge rules file (#126). Users tell agents what else to ask or report in the
  agents' own instruction files; `docs/tell-your-agents.md` says where.
- `evals/skill` checks the skill with real sessions of each harness on the smallest models.

### The harness's own ask tool

- Claude Code (#121, #200): a `PreToolUse` hook on `AskUserQuestion` allows the call with
  `updatedInput.answers` that say to ask through `starbridge ask`. A deny would show as a red hook
  error. It lets the question through when the machine is unpaired or the server does not answer
  within 3 s.
- opencode (#345): each `question` call becomes one Starbridge question per question, already
  waiting, and the answers go back into the call through `POST /question/{id}/reply`. The first
  answer, on a device or at the keyboard, wins; the other side is settled `elsewhere`. A question
  with more than 4 options or a label over 100 characters takes a typed reply.
- Pi has no built-in ask tool; Starbridge intercepts none by name.

### Permission prompts

Off by default (#124): the Claude app already shows prompts for Remote Control sessions, and the
gain is every session, machine and agent in one place. `starbridge config permissions on|off`.
Codex prompts are not supported.

- **Claude Code** (#57). A `PermissionRequest` command hook (600 s) races the dialog. Its input has
  no `tool_use_id`, so the hook settles a call by the hash of its `tool_input` on `PostToolUse` and
  `PermissionDenied`, and all of a session's prompts on `Stop` and `SessionEnd`. `PostToolUse` runs
  a shell check that starts the CLI only while the CLI marks an unexpired prompt open
  (`<config>/permissions-open`, written with the state), or when a state has no mark yet, as from
  an older CLI: starting it on every tool call cost about 50 ms and 50 MB, prompts on or off
  (#517). "This session" and "always" are offered only
  for `addRules` and `addDirectories` suggestions whose rules fit in full; a `setMode` suggestion
  changes more than the call, so it stays at the keyboard. A deny with no message tells the agent
  the owner denied it.
- **Pi** (#232, #288), through pi-permission-system's authorizer chain: the link `starbridge`,
  once the owner names it in `authorizerChain`. A link cannot allow for the session, so devices
  offer Allow and Deny. Asks on the `path` and `external_directory` families stay at the keyboard,
  since pi-permission-system drops a link's allow there. The devices see the whole command line
  an Allow runs, not only the command of it that asked (#488). While the devices hold the prompt
  Pi shows "Answer here", which takes it back.
- **opencode** (#300): every prompt publishes `permission.asked`, and the plugin answers through
  `POST /permission/{id}/reply`. The first answer wins. `opencode run` rejects every prompt itself.
  The devices see what an Allow approves (#489): an `edit`, which its edit, write and apply_patch
  tools ask, as `{file_path, diff}`, the path first so it stays the summary and naming where an
  apply_patch move takes a file and which files it deletes; an `external_directory` ask from the
  shell as its directories and command; any other permission with its metadata. An MCP call shows
  only the tool's name, since the event carries none of its arguments.
- **A stalled server never holds a prompt** (#260): deadlines and SIGTERM cut every request the
  hook makes. When a hook dies mid-hold, the local agent settles its prompt as answered at the keyboard
  (#400).

## Items

### Questions

- Fields: `question`, `context`, `options` (2 to 4, or none for a typed answer), `recommended`,
  `source` (machine, project, session, its title and links, `machineKind`), `agent`, `images`,
  `links`, `answerIn`, `done`, `replies`.
- **The first option is the agent's default** (#191), its proposal with no timer: listed first,
  the one amber button. `recommended` names it when it isn't first.
- **Typed replies** (#201). Every question with options also takes a typed reply, as a steer to act
  on. It goes alone, with no choice.
- **Images** (#62, #170): at most 4, PNG or JPEG, never SVG. The CLI keeps a file as is up to a
  3000 px edge, so a phone screenshot reaches six devices unchanged and viewers can zoom into real
  pixels. Android decodes by the image's real size, drops one larger than declared or 8192 px a
  side, and holds at most 4096² pixels in a decode (#360).
- **Links** (#171) are what the agent wants the owner to see before answering: a Claude artifact, a
  PR, a doc. They never answer the question. Each has a `title`. Clients show them under "Attached
  by the agent". A claude.ai link opens in the browser, where the owner is signed in; the Claude
  app shows artifacts only in its in-app browser. A GitHub PR or issue link without a title reads
  `owner/repo#123` with the GitHub mark.
- **`answerIn`** names a page (a Claude artifact whose button messages the agent) where the
  question is answered. It has no options; the schema refuses both. It closes when the agent runs
  `starbridge settle`, or when the owner taps Done beside the page's link (#539): an agent that
  forgot to settle left the card in Needs you. Done is an answer that carries no pick, so it closes
  the card on every device and reaches the agent as `answered on its page; read the answer
  there`; the page stays the one place the owner answers. Clients show Done only when the
  machine says it takes one (`done`), since an older CLI would drop it and the agent never hear.
- **Waiting state** (#122, #191, #202). A `waiting` item says whether the agent is blocked on the
  question. A flip either way pushes, so the phone moves the notification between channels. `ask
  --waiting` posts the question quietly and lets its `waiting` item push, so the first
  notification already says waiting.
- **Settling** (#62, #405). `settle` closes a question as `elsewhere` or `withdrawn`. It never
  withdraws one whose answer reached the agent, since devices would hold both.
- **Who won a race** (#330). Answers are sealed only to the asking machine, so once it accepts one
  it posts a `settled` notice with the device and its choice or text, sealed to every device. The
  losing device then says "Answered on Pixel: Later".

### Permission prompts

- **Allow covers what the owner saw** (#274, #356). A prompt's `summary` is capped at 200
  characters, so a command could hide a tail past it. The detail and sheet show the whole redacted
  input and enable Allow once its end has been on screen. A row, card or notification allows
  directly only when the whole input fits its one line; otherwise Allow opens the sheet. A
  notification's line counts at most 400 dp, a phone's in portrait: on a tablet, a foldable or in
  landscape the shade is a fixed-width panel or a split column, narrower than the display (#490).
- **Lock screen** (#389). Deny answers from there. Allow asks for the unlock, then opens the
  prompt's sheet. "Quick Allow" in Settings (off, labelled unsafe) sends at once instead (#390).
- **Escapes** (#357, #410). Control and format characters show as escapes (`‮`), on the
  machine before sealing and again in every client, so a bidi override cannot reorder the command.
  An input with two keys that read alike once redacted or escaped stays at the keyboard.
- **Redaction** (#358, #359). The summary and description are cut from the input after
  redaction. A private key's lines go also when they carry a diff's `+`, `-` or space (#489).
  `inputHash` is keyed under the machine's signing key, so a device holding the redacted input
  cannot test guesses for a short redacted value.
- History says how and where a prompt was answered ("Denied · on Pixel"), from the machine's
  `settled` notice (#349).

### Runs

- `starbridge run --title <t> --reason <r> -- <command>` (#60). The reason is required: it tells
  the owner why this run is theirs to watch. The run posts its start, progress at most every 10 s,
  a heartbeat every minute and its exit. Output goes through a pipe, so tools that print progress
  only to a terminal show none.
- Devices call a run lost 3 minutes after its last update (#190, #249); the server cannot read a
  sealed run, so this is client-side. A lost run shows "Lost, no news for 3 min 37 s" and no
  elapsed time, since its last news may predate most of its life. A run with no progress shows an
  indeterminate bar.
- Runs sit above the questions; finished ones stay 30 minutes. Android shows a notification per
  run, a Live Update on Android 16. The web polls every 2 s while a run is live and the page is
  visible, else every 10 s.

### Quotas

- **The uploader** in the local agent runs CodexBar for every provider at once, every 5 minutes
  and on request, and computes pace and alerts (`packages/protocol`), so clients only render.
- **Alerts** (#115): `low` at CodexBar's defaults (50% and 20% left), and pace: unused headroom of
  30% one hour before the reset for windows of a day or less, one day before for longer ones. Only
  a new alert notifies; every other snapshot is posted quiet. The thresholds are fixed, since
  devices' settings never reach the uploader. A reset that moves by less than half its window is
  the same cycle, as in CodexBar.
- **A failing provider** (#397, #450) is asked once more, then keeps its last good windows, sent
  with the error and when they were read. Kept windows raise no alerts and go once their reset
  passes. A provider with nothing to keep shows only its error. Devices get a short error; the CLI
  logs CodexBar's whole. The run timeout is 120 s.

### Quota settings follow CodexBar

A curated set of CodexBar's own settings, with CodexBar's meaning, per device (#115): bars show
used (the default; CodexBar defaults to remaining) or remaining; reset times relative or as a
clock time; workday ticks on weekly bars (off, 4, 5 or 7 days, and their style); per provider
show, notify and order. "Notify about" picks low, pace or both. Cost tracking and menu-bar-only
settings stay out. Android shows quota notifications on a low-importance channel; the web shows
them only while a page is open, since quota snapshots skip Web Push.

### Quota order

One rule on both clients (#159, #162). Hidden providers drop out; the rest go in the order set in
Settings (unlisted ones after, in the uploader's order), each provider's windows in the uploader's
order. "Running out first", on by default, then moves windows that will run out or ran out, and
have not reset, above the others. Windows are grouped by provider (#160); groups follow their
first window, so a provider with a window running out leads.

## Clients

### Both clients

- **Inbox order.** Runs first, then permission prompts, then questions whose agent waits, then the
  rest, each oldest first. The view offers one feed, "Group by machine" or "Group by waiting"
  ("Waiting on you", "When you can"), remembered per device.
- **One card system** (#248). Every item is a filled card; what blocks an agent differs by one
  thing, the amber fill. A waiting item's title is weight 500 and its time slot a clock ticking
  from when it started waiting; screen readers hear "Waiting for you, 2 minutes" first. No state
  tag anywhere. Under a grouping, the items under one header are joined.
- **History** lists answered questions and the last 7 days of prompts, with how and where each was
  answered.
- **Find** matches every word in the machine, repo, the agent's words, the session and a History
  item's answer. On the web it lists open matches, then History's; Android uses Material 3's
  search view.
- **Answer buttons** (#138, #166): "Answer buttons on questions", Always (default), When the agent
  waits, or Never, applies under 1100 px. More than two options, or a label over 18 characters,
  stack. `answerIn` and typed-only questions have no buttons.
- **Context** renders line breaks and code, inline and fenced. Other Markdown shows as typed; the
  skill says so rather than the clients growing a renderer.
- **Revoked machines.** Their items leave the Inbox and their notifications close (#344).
- **Clock** (#161): System, 12-hour or 24-hour, per device. UI words stay English.
- **Images** open a full-screen viewer (zoom, pan, swipe or arrow keys between images) and carry
  an expand badge, since nothing else tells a touch screen they open (#170).
- **Signed out.** A browser that holds no device of the account it last signed in to gets the
  landing page at `/`, as does a revoked browser (#209); one with a device gets sign-in.
- **Restarts go unnoticed** (#250). Clients retry a 502, 503 or refused connection quietly for
  20 s. A write retries only when it cannot have landed; the web's writes retry on 502 and 503
  only, since it cannot tell a refused connection from a cut one.
- **Devices.** Rows that share a name show when each was added (#287). A Recovery key row says
  when and on which device the key was set, with Replace; other devices show a replacement once
  (#348).

### Web

- **Security headers** (#312). Next sets a per-request nonce CSP in `web/src/proxy.ts`: scripts
  need the nonce or `'strict-dynamic'`, `'wasm-unsafe-eval'` lets libsodium compile, and an inline
  script sets Zod's `jitless`. Styles allow `'unsafe-inline'` (React style attributes), images
  `data:` and `blob:`, `frame-ancestors 'none'`. Every page renders per request. Caddy adds HSTS,
  `nosniff` and `Referrer-Policy: same-origin`.
- **Back** (#347). Under 1100 px an open item is `/?item=<id>`, its own history entry, so Back
  returns to the list. Dialogs are modal `<dialog>`s, which Chrome on Android closes on Back.
- **Backoff** (#332). All calls in a page share one backoff, 250 ms doubling to 30 s with jitter,
  ended by any answer or the browser's online event. Pollers skip their turn while it waits.
- **Notifications.** The service worker shows one per question and closes it once answered. Its
  actions answer only for the account it was shown for (#274). Signing out, revocation or adopting
  new keys closes them all (#311).
- **Sound**: off by default, while a page is open only; a service worker cannot play audio.
- **Layout.** Panes resize by dragging or arrow keys. From an 840 px page, Quotas is one table and
  providers reorder by drag or keys; a group that "Running out first" pins shows a pin with a
  popover explaining why (#296, #351). The detail pane widens with the window (DESIGN.md `wide`).
- **Layout checks fail CI** (#305): every e2e screenshot at 390 and 1280 px, rechecked at 320,
  fails on overflow, clipped text without an ellipsis, overlapping text, or a CSP violation.

### Android

- Material 3 Expressive, by the guidelines (#49). Colours: "Starbridge" (default) or "Material
  You"; amber, the quota states and provider colours stay fixed under both.
- **Notification channels** (#191, #196): "Needs you" (Waiting for you, high importance;
  Questions, default; Permission prompts; Join requests) and "Activity" (Runs; Quotas, low).
  Android never lowers an existing channel's importance, so changing one needs a new channel id. A
  flip to waiting re-posts the notification on the other channel. Sort keys put questions and
  prompts first.
- **Notifications** show at most three options; a fourth needs the app. A prompt's shows only its
  command. Android's contextual chips are off, so the only buttons are answers. With sensitive
  content hidden, the lock screen's public version carries the same buttons.
- **No answer is lost** (#329, #331). An answer is sealed, signed and stored before it is posted;
  WorkManager sends it once a network is up. A retry the server already took gets
  `already-answered`, which the app counts as its own when an earlier attempt may have landed.
- **Notifications off** (#342): a line heads the Inbox with "Turn on", which opens the app's
  notification settings, since Android stops showing the permission prompt after two refusals.
- Pull to refresh shows only on the screen that was pulled.
- **Update screen** (#497): when the server answers 426 `client-too-old`, the app shows only
  "Update Starbridge", the server's minimum and this phone's release, and one button back to
  where the app came from: Google Play, Obtainium (its launch intent, else the release page), or
  the latest GitHub release. The updated app starts without it. Answers given meanwhile wait in
  the outbox for it. Signed out, the refusal shows as a notice instead, so the owner can pick
  another server.

## Brand

The mark is a space elevator: a planet's edge, a vertical tether and one amber climber (#32). Stars
were ruled out as a cliché of AI tools. The name stands on the mark's baseline in every lockup.
Beacon (#49): soft black and neutral greys, and amber as the only accent, meaning "needs you".
Provider colours are CodexBar's, adjusted per scheme only as far as 3:1 contrast needs (#72).
Tokens, type and components: `DESIGN.md`.

## Releases, deploys and CI

- **Releases** (#64). A `v1.2.3` or `v1.2.3-rc.4` tag runs `release.yml`: the APK and AAB signed
  with the release key, six CLI binaries (Linux and macOS, and Windows `.exe`, each x64 and
  arm64, cross-compiled by Bun on Linux), `SHA256SUMS` signed with minisign in CI (public key in
  `cli/minisign.pub`), `install.sh`, and notes from merged PRs. `-rc` tags are prereleases and go
  to npm under `next`. Non-rc tags commit the formula to `T0mSIlver/homebrew-starbridge`. The npm
  step skips without `NPM_TOKEN` (#480). versionCode is `2000000 + MAJOR*1000000 + MINOR*10000 +
  PATCH*100` plus the rc number or 99, so release candidates sort first; the 2000000 keeps 0.1.0
  above 1.0.0-rc.1 (1000001), which Play's closed test already had (#551). Play App Signing keeps the release
  key, so Play and GitHub builds share one signature (#148).
- **One version everywhere** (#471). `bun cli/scripts/version.ts <version>` stamps the version
  into `cli/package.json`, `web/package.json`, both `plugin.json`, the mod's `VERSION`, Android's
  default `versionName` and the marketplace's two `ref`s, in a PR; the merged commit is tagged,
  and the release workflow refuses a tag that disagrees (`--check`, also a test on every PR). The
  marketplace lists both plugins as `git-subdir` sources at that tag, over https so no SSH key is
  needed, so a hook merged on main never reaches users before the CLI that supports it. A release
  candidate moves every version but the marketplace refs. Setup and `starbridge update` install
  the Pi package at the CLI's own tag. The mod keeps its own copy of the agent API revision, since
  Claude Code installs only `mod/`.
- **Deploys** (#26, #150, #260). A merge to main deploys from Actions once CI passes, over SSH to a
  forced command that deploys only main's head or a commit on main containing the deployed one;
  the box fetches it itself. Rollbacks are manual (`deploy/deploy.sh`). The deploy fails unless the
  live server reports that commit or a later one (`x-starbridge-revision`). That header, and
  `starbridge-deploy`'s argument, are refused unless they are 40 lowercase hex characters (#467),
  since the workflow puts the revision in a `gh api` path.
- **No downtime** (#150, #508). The page runs as two copies; a deploy starts the idle one, waits
  for its health, then stops the other, and Caddy sends every request to the first healthy copy.
  The server stays one instance, since it holds the long-polls and SQLite; Caddy holds requests up
  to 30 s while it restarts, which takes about 1 s. The Caddyfile reloads through Caddy's admin
  API. Only a change to `deploy/caddy.Dockerfile` recreates Caddy and drops connections: its image
  is tagged by a hash of that file, which pins every input, and built only when no image has the
  tag, since a rebuild after the build-cache prune yields a new image even from the same file.
- **Pinning** (#361, #423, #426). Actions are pinned by commit SHA and images by digest, so a
  dependency changes only in a Dependabot PR. A workflow writes `pnpm-lock.yaml` into Dependabot's
  security PRs, which update `package.json` alone, then dispatches CI, since a push with
  `GITHUB_TOKEN` starts no workflow. The images install pnpm with `npm install -g` at
  `packageManager`'s version, since node slim images ship no corepack (#430).
- **CI** (#380). Main runs one at a time; a newer merge replaces the waiting run, and the head's
  deploy covers the merges in between. A pull request runs only the jobs its files can affect;
  skipped jobs still report success. The e2e runs under `.github/watchdog.sh`. Tests point
  `TMPDIR` at one directory per run and remove it (`test-tmp.ts`, #313). A `windows-latest` job
  (#552) runs the CLI's platform tests and starts a built `.exe`; the rest of the CLI suite runs
  there without failing the job until it passes. A private repository skips it, since GitHub's
  Windows runners need a public one or paid minutes.
- **Monitoring.** `uptime.yml` checks `/healthz`, `/healthz/backup` (fails when the last nightly
  backup is over 26 h old) and `/healthz/disk` (under 2 GB free), and opens one `outage` issue.

## The hosted instance

- **Stack** (`deploy/`): Docker Compose with Caddy on the host network, so rate limits see real
  client addresses. Caddy keeps connections to the server open (`keepalive 25s`, below the
  server's 30 s idle close) so TIME-WAIT sockets don't use up ports (#376). Nightly SQLite backups,
  kept 14 days.
- **Capacity** (#301). A load test of the production stack on two cores held 2000 simulated users
  at a 194 ms p99. On the production VPS, Caddy's memory runs out first, near 8000 users (each held
  long-poll costs about 96 KB in Caddy and 13 KB in the server); CPU near 10,000.
- **Privacy and terms** (`/privacy`, `/terms`). Each claim follows the code: stored columns in
  `server/src/db.ts`, retention in `server/src/limits.ts`, logs and backups in `deploy/`. A change
  to what is stored changes the page, and the Play data-safety form. Contact is
  privacy@starbridge.run; abuse@ appears only in `/terms`.
- **Analytics** (#141). Umami, self-hosted, on the landing page, `/privacy` and `/terms` only, never
  the app. No cookie, no stored IP, a daily salt, Do Not Track honoured, so no consent banner.
  Caddy rate-limits its open endpoint, and a timer caps its tables, so it cannot fill the disk.
- **Demo server** (#423). Play reviewers cannot pass GitHub's new-device check and cannot be given
  a recovery key, so `demo.starbridge.run` is a self-hosted server with an owner token, and
  `demo/` is its first device and machine. It approves every join by digits without comparing,
  so a reviewer walks the same screens as a real second phone. The server refuses `DEMO=1` beside
  a starbridge.run `PUBLIC_URL`, GitHub sign-in or relay mode. A restart is a fresh account.

## Platform facts

What the code relies on, with the versions checked.

- **Claude Code mods** (2.1.286 to 2.1.289): `$.http.fetch` aborts any request without a complete
  answer after 30 s. `$.prompt.submit` starts a turn in an idle session within 0.2 s; mid-turn it
  queues its own turn after the running one, and resolves only when that starts, so a poll loop
  must not await it. Remote Control shows a submitted prompt on the phone. A hot reload aborts the
  mod's requests. `/resume` fires `session.end` with reason `resume` and no `session.start`. Mods
  load only from user or managed settings or an installed plugin, not project settings.
- **Claude Code sessions**: `~/.claude/sessions/<pid>.json` holds `sessionId`, `name` (the title)
  and, under Remote Control, `bridgeSessionId`; the Remote Control URL is
  `https://claude.ai/code/<bridgeSessionId>`. Records are rewritten in place without truncation,
  so read only the first JSON object (`cli/src/claude.ts`).
- **Claude Code hooks** (2.1.289): `PermissionRequest` waits up to 600 s and races the dialog. It
  fires under `--dangerously-skip-permissions` for `ask` rules and for Remote Control's `--print
  --sdk-url` children, not for auto mode's classifier blocks, which reach hooks only as
  `PermissionDenied`. When the keyboard answers Yes first the hook gets no signal; Esc or No sends
  it SIGTERM. Every `PreToolUse` deny shows as a red "hook error". In cloud sessions only repo hooks
  run, and environment variables are readable by the agent.
- **Codex** (CLI 0.160): the TUI runs sessions in a shared app-server daemon; `codex queue --thread
  <id> --message <text>` starts a turn in an idle session or runs next in a busy one, and starts
  the daemon itself. It takes the message only as an argument and refuses sub-agent threads. An
  exec thread's rollout has `originator: codex_exec`. New or changed hooks need trust at launch.
- **Pi** (0.87.1, 1.0.4): `pi.sendUserMessage(..., { deliverAs: "followUp" })` behaves like
  `codex queue`. Commands get `PI_SESSION_ID`. pi-permission-system (33 to 40) caps every
  authorizer link's allow on `path` and `external_directory` to defer (its ADR 0007; making it
  configurable is its #620). A bash allow pattern is never safe there (#488): before 9.0.1 it
  matched the whole line, so `starbridge ask *` passed `starbridge ask x; curl … | sh`; from 9.0.1
  it matches each command of the line but takes a `VAR=…` prefix off first, so it passed
  `NODE_OPTIONS=--import=data:… starbridge ask`. A bash ask names only the command that asked in
  `command`, the line in its "full command" evidence (26.0.0 on), and a link's allow runs the line. Its dialog appears after 1 s, and a dialog opened over another
  strands it.
- **opencode** (1.18.31): the `permission.ask` hook is declared but never called; prompts publish
  `permission.asked` and take `POST /permission/{id}/reply`. `question.asked` and `POST
  /question/{id}/reply` work the same way. Plugins get an in-process SDK client;
  `experimental.chat.system.transform` is the only hook that adds to the system prompt; `shell.env`
  sees each bash call's session id. Worktrees of one repository share a `projectID`.
- **CodexBar**: `usage --provider <unknown>` exits 0 and prints every provider, so the uploader
  keeps only matching rows. Mistral windows carry no `windowMinutes`, so they get no pace. The
  Claude probe drives `claude /usage` and can take 10 s on a busy machine.
- **Browsers**: WebKit 26 reads an X25519 `CryptoKey` back from IndexedDB as null. iOS gives Web
  Push only to Home Screen apps. Chrome prefixes the app name to an installed window's title
  unless the title starts with it. Umami drops headless browsers' hits as bots.
- **Android**: OkHttp retries a POST whose connection dropped before the reply started, so a
  server may receive it twice. Android 16 draws the notification accent itself. Material 3's
  expanded `SearchBar` passes a screen-filling minimum height to its field (#341).
- **Skill eval** (#299): what lifted scores was one context line per option starting with its
  label, "no answer is never a yes" placed where the agent waits, and card text in single quotes
  (`$0` in double quotes blanked a Codex card). Records: `evals/skill/results/299`.

## Open questions

- Should cloud sessions get a machine? The agent can read its key from the environment.
- Android App Links on starbridge.run, on top of PKCE, would close the hostile-app sign-in gap for
  the hosted domain (#34).
- Does Safari on iOS lose X25519 keys as WebKit does (#116)?
- Tap targets under 44 px and contrast under 3:1 are listed by the layout checks, not failed,
  until a ruling (#305).
- An offline banner on the web (#332).
- Revoking the old machine in a `pair --force` approval would need a `replaces` field (#287).
- Sealing an image once with a key in each box would free the per-device size cost; not needed
  while accounts pair a few devices.
