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
Copy says "on each machine that runs agents", never "on each machine" alone. The subtitle under
the hero sells questions and that every agent on every machine reaches you in one place; the
feature row below names runs, quotas and permission prompts, since a list in the subtitle repeats
it (#801). The line under the hero's buttons, with end-to-end encryption, shows on phones too.

### Platforms

The web app ships first wherever it can: installed to the home screen on iOS (Web Push works for
home-screen web apps since iOS 16.4) and as an installed app on desktop browsers. Android is a
native app. No native iOS app until there is demand and a device to test on.

The desktop app is Electron, loading the configured server's web page (owner, 2026-10-08). The
page stays the device: it signs in, pairs and keeps its keys as in a browser, so every web release
reaches the app without an app update. The app adds what a browser cannot: the Needs-you count in
the menu bar, notifications with the options as buttons and a typed reply, delivery while no
browser runs, `starbridge://` links, and later presence (#848). Electron is the only stack with
all of these on macOS and Windows; Tauri would need a static export of a web app that renders
per request, and it has no typed reply nor idle and lock detection. The cost is a ~150 MB
download. The comparison is in the planning repo's
[research/desktop-app.md](https://github.com/T0mSIlver/starbridge-planning/blob/main/research/desktop-app.md).

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
CLI uses no Bun global without a guard. SQLite is enough because the server stores ciphertext,
public keys and the directory's names and times. Design tokens are generated from `DESIGN.md` to CSS and Kotlin, so both clients
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
- **A machine's check code** (#795). A pairing code that reaches a browser lets a hostile server
  approve the machine into a chain it controls, which no device in that chain can expose, so the
  owner compares: the machine shows three groups of 80 bits of a hash of its `add` entry and
  saves the pairing only once a person types the fourth from the Android app. The entry, not the
  keys: a pairing request proves no private key, so a stand-in can copy the machine's keys, and
  a fork can keep the owner's entry 0; the entry's `prev` ties it to the chain, and its
  signature, which the server cannot predict, stops a search for two entries that match. Typed rather than
  a yes, so an agent running setup cannot confirm it; the owner chose a confirmation on every
  setup over a code only shown.
- **The recovery key** is a random 16-byte seed shown as 28 Crockford base32 characters with a
  12-bit check, in seven groups of four, read in any case, with or without dashes (#199). 128 bits
  is Ed25519's own security level; the seed is random, so it needs no slow key derivation:
  BLAKE2b-256 of `"starbridge/v1/recovery-seed" NUL seed` stretches it to an Ed25519 seed. It is not
  shown as words: a new site that shows 12 words and later asks for them back looks like
  seed-phrase phishing, and Chrome flagged starbridge.run for it. No page says "seed" or "phrase".
- **The recovery key can be copied or saved to a password manager, never screenshotted** (#817).
  Android's key screens block screenshots, screen sharing and the recents thumbnail
  (`FLAG_SECURE`): a screenshot lands in the photo library and its cloud backup, where nobody
  looks for a secret. Copy puts the key on the clipboard marked sensitive, so keyboards and the
  clipboard preview hide it, and clears it after a minute if it still holds the key (or if the app,
  in the background, can't tell). Save to password manager goes through Credential Manager, not
  the share sheet: Google Password Manager takes no shared text and Bitwarden turns it into a
  Send, while a saved password reaches all three of Google's, Bitwarden and 1Password. Without
  either, owners had no way to save the key but typing it out. The web already had Copy.
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
- **Versions** (#468, #469, #478, #551, #737). 0.1.0-rc.2, for which the hosted database was reset
  before launch, is the compatibility floor, so nothing carries code for a database, stored
  setting, client or server before it: the schema starts at one migration, `ask` refuses
  `--default` and `--default-at` rather than ignoring them, and clients, setup and the CLI dropped
  what served earlier releases. One exception: a CLI state file without `v` still reads as format
  1, since the owner's machines keep such files through the reset. Later compatibility branches
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
  damaged one, or one without `v`, is replaced at the next change, since it holds only display
  choices. IndexedDB's own
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
- The owner can pause sign-ups (#784), for a launch-day flood or a box near its limits: a GitHub
  user with no account gets "not taking new accounts right now" on the page and in the app, while
  every existing account signs in as before. `bun server.js signups pause|resume` writes and
  removes a file beside the database, which the server reads on each new account, so it takes
  effect at once and survives restarts and deploys.
- The page shows only the sign-in methods its server offers (#670): `GET /v1/auth/methods` lists
  them, and without GitHub the landing page's and sign-in page's buttons open the owner token
  form. Until the server answers, the page shows GitHub, the hosted server's, so the landing
  page's HTML keeps its buttons.
- Android (#34, #527): the app signs in with PKCE, and GitHub binds its code to the app's
  challenge, so only the app holding the verifier can trade the code, whoever catches the
  redirect. Known gap: a hostile app can start its own sign-in, and if GitHub skips the consent
  screen it gets a session.
- On starbridge.run, GitHub redirects the app's sign-in to `/v1/auth/github/callback/app`, an
  App Link the app catches (#527). The installed web app's scope is the whole origin, so Chrome
  handed it the page's callback when no other app claimed that; where both claim a URL, Chrome
  opens the verified app. The page's sign-ins keep `/v1/auth/github/callback`, which the app does
  not claim, so they stay in the web app.
- When the browser gets the app's redirect (app missing, verification failed), the
  server passes GitHub's code on to `APP_REDIRECT_URI`: on starbridge.run the App Link
  `https://starbridge.run/app/auth`, whose page has an "Open Starbridge" button to
  `starbridge://auth`. Chrome asks "Continue to Starbridge?" before following a `starbridge://`
  redirect that no tap started; after a tap it does not. Self-hosted servers keep
  `starbridge://auth`, since the APK can bind only starbridge.run.
- `assetlinks.json` lists only the release key, which Play App Signing also uses. A debug
  keystore's password is public, and an app signed with it would verify as the App Link handler
  (#569). Dogfood builds sign with the release key instead, opted into by a gitignored
  `local.properties` line on the maintainer's machine and refused under CI; other debug builds keep
  the debug key, and their sign-in falls back to the `starbridge://auth` button.

## Server

- **Bounds** (#65, #260), sized for an orchestrator with 10 sessions asking a few hundred
  questions a day: every route that stores something has a cap or retention, and every write that
  grows it a rate limit. Answered questions and their answers are kept 7 days, unanswered ones and
  quota snapshots 30. An account holding more than 1000 unanswered questions keeps them 7 days
  (#584): a looping agent fills the 10000 cap in under 2 hours, after which every question is
  refused until some expire, and 30 days of that is too long, while a person has a few dozen
  open at most. A snooze in such an account can outlive its question and goes with it. Per account: 10000 questions, 10000 permission prompts, 256 MB, each item
  charged its boxes plus 512 bytes per row: a heavy user, a hundred questions a day with
  screenshots, stores about 80 MB in a week. A full account gets 409 `account-full`, which the
  CLI words as such. The numbers live in `server/src/limits.ts` and
  PROTOCOL.md, "Limits". A post reads counts from a totals table kept by triggers.
- **Retention comes from `ITEM_KINDS`** (#477). Each kind names its `keep`: a day, a week or a
  month after it was received, answered or left unanswered; `withRe` (it goes with the item it
  refers to); `fromActive` (it goes when its machine is revoked). The hourly sweep builds its
  deletes from that table, and a kind without `keep` fails typecheck, so no kind is stored and
  never dropped. The periods are server limits, so tests and self-hosters set their length.
- **Sizes** (#170, #685). A question's boxes and image blobs may hold 2 MB together and one image's
  blob 512 KB of base64url; the request body limit is 3 MB. Each image is encrypted once with a
  random key and stored once; only its key and hash go in each device's box, with the text. Tom's
  first evening of dogfooding stored about 370 KB per question, mostly screenshots sealed once per
  device; one 110 KB screenshot to 3 devices went from 591 KB stored to 152 KB.
- **Runs** are one item the machine re-posts under its id; the server keeps the latest, at most
  500 per account, for a day after the last update.
- **Permission answers** are refused 10 minutes after the prompt arrived, since the server cannot
  read its `expiresAt`.
- **Pairings** (#309, #619). Each address may hold 50 unapproved pairings (IPv6 counted per /48
  on this route), on top of 30 a minute; the server-wide cap of 20000 is the disk bound. Mobile
  carriers that hand out /64s from one /48 share 50, a smaller blast radius than the whole
  server. The server counts them in memory, as every per-address limit, so no address reaches
  the database, and a restart resets the counts (#575).
- **Per-address sign-up limits** (#619). An office or carrier NAT puts many people behind one
  IPv4 address, so the pairing limits above and the 60 GitHub sign-ins a minute leave room for a
  launch-day crowd behind it; at one a second they stay far below the 10 sign-ups and visitors a
  second the load test held.
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
  answers count. Re-sealing stops at its first 429 and waits its Retry-After, so the rest of the
  machine's rate window goes to its own asks (#650). A question's images are scaled at `ask` to
  leave room for its box, with its recipient list grown, for the 64 devices an item can reach,
  since a re-seal keeps the stored images and the 2 MB cap counts them (#720). One the server
  still refuses as too large, as one with a lower cap may, is not re-sent: the machine says so once.
- **Fresh quotas** (#158, #450). The local agent posts a snapshot once its directory holds a new device.
  `POST /quota/ask` wakes the machines and holds until each posted, up to 25 s, under the 30 s at
  which proxies cut long polls; 6 a minute per account, since each runs CodexBar on every machine.
- **Schema migrations** (#470). `PRAGMA user_version` counts the migrations a database has run;
  each runs in one transaction with its version. A server refuses a database newer than it knows,
  so a rollback past a migration fails at start instead of writing rows the newer schema misreads.
  Version 1 is the whole schema: the six migrations before launch were folded into it when the
  hosted database was reset, so `apply.sh` stops a deploy whose database is newer than its server
  before it replaces anything. A migration changes the schema and never rewrites rows, to stay within the 30 s
  Caddy holds requests; backfills run in the hourly sweep. `apply.sh` backs the database up just
  before a new server that migrates further than the database's `user_version` starts, or when
  either number can't be read, and keeps the last two (#586) for 7 days at most, as the nightly
  copies, so deleted data leaves backups within the 2 weeks /privacy promises (#721).
- **Server-wide cap** (#586). Machines' items stop at 2 GB stored across accounts, with 503
  `storage-full` and a Retry-After of an hour; answers pass, so questions still close and expire.
  The hosted disk (38 GB, about 10 GB of it system and Docker, an alert at 2 GB free) holds the
  live database plus 7 nightly and 2 per-deploy copies, 10 in all. Copies are `VACUUM INTO`, so
  free pages stay out: 10 × 2 GB, plus SQLite's overhead, is about 21 GB of the 26 GB above the
  alert, the rest for a week of Docker builds between weekly prunes. Eight accounts at their
  256 MB fill it, a risk taken over buying disk before launch.
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
  relay is open, rate-limited per IP and in all (600 a minute in Caddy; 16 Web Pushes in flight
  in the server, 4 per address), so nobody can aim it at a host or burn the VAPID key (#577). It
  pushes only ciphertext or ids. A push carries the
  device's ciphertext when it fits FCM's 4 KB, else the item id.
- Quota snapshots and runs skip Web Push: browsers drop subscriptions whose pushes show no
  notification (Firefox after 16). The web page polls them instead.
- Caps (#27, #36, #37): 10 subscriptions a device, 30 an account; 4 pushes in flight and 200
  waiting per account, 10 s each. A push connects to the exact address that passed the
  private-range check, and is sent only if its subscription and device are still active (#260).
- A server's VAPID key can change, as when a self-hoster leaves the relay for their own keys
  (#567). Each page boot compares the browser's subscription key with the server's and subscribes
  again when they differ. The server drops a Web Push subscription its push service refuses with
  403, as RFC 8292 has it for a key mismatch; a UnifiedPush 403 is the distributor's access control
  and keeps the target. The cost: a 403 for another reason, such as a server clock hours off, drops
  the account's browser subscriptions too, and each comes back only when its page opens. Those
  pushes were failing anyway.
- An Android app in front syncs every 10 s until a push has reached it (#445), since a server
  without a relay or UnifiedPush pushes nothing and cannot tell.
- **Held pushes** (#848). A question that shows in the agent's picker and on the owner's screen
  needed no buzz on the phone too: a quick back and forth at the desk did that. So while any of
  the owner's machines or devices says they sit at its screen, the push of a question, a
  permission prompt or a waiting flip waits the account's hold time (30 s by default, off to
  2 minutes in Settings) for every device not itself in use, and goes only if nothing answered it
  meanwhile. Only the push waits, never the item: every device lists it at once, and a held card
  looks like any other, since the owner chose no state that flips while they look. With no presence
  signal, which is every older client, pushes go at once as before. The server reads presence as
  one bit per source, in memory, since the hold is all it is for: no idle time, lock state or
  reason, nothing on disk, and a restart means push now. Presence counts per person, so a Mac in
  use holds a question from a headless dev box. The hold is one account setting, since the server
  applies it and it is about the person, not a device. PROTOCOL.md, "Held pushes", has the
  timings.

## Machines

- **The local agent**, `starbridge agent` (#68), one per machine as a user service (systemd, launchd, or a Scheduled Task on Windows), owns the
  keys and the server connection, uploads quotas, and routes answers, prompts and runs to sessions
  over HTTP on a unix socket (PROTOCOL.md, "Local agent API"). Every CLI command asks the local
  agent first and talks to the server itself when none listens or it answers 426; once it has
  answered it never falls back, so nothing posts twice. `wait` is the exception (#548): the agent
  marks an answer seen only for a client still listening, so when it restarts under a wait, the
  wait asks the new one, and after 30 s with no agent it waits at the server. Answers stay in the CLI's state file,
  so both paths share one store. A session with no mod whose wait died still never notices its
  answer; `starbridge status` lists the answers no session has taken, with the `wait` that prints
  each (#557).
- **Files** in `~/.config/starbridge` (or `$XDG_CONFIG_HOME`, `$STARBRIDGE_CONFIG_DIR`): 0600 in a
  0700 directory. A `.lock` guards every read-modify-write (#33). A directory refresh keeps the
  longer of the fetched and saved chains, each required to extend the other's pin.
- **The socket** is bound under a 077 umask (#95). There is no peer uid check, since neither Bun
  nor Node exposes `SO_PEERCRED`. The local agent runs only the CodexBar binary its own config names,
  never a path a client sends.
- **On Windows** (#552) the agent listens on loopback TCP with a per-start token in `agent.port`
  in the config directory (PROTOCOL.md, "Local agent API"). A named pipe was the other choice:
  libuv creates one with the default DACL, which lets other users open it for reading, and Bun's
  named-pipe `listen` has crashed in Claude Code's own use. The token never crosses the wire:
  each call and each answer proves it over a fresh nonce, so a process that takes the port of a
  stopped agent can neither use what it hears nor answer. A client still sends its call before
  it sees the answer's proof, and a dead agent's port shows in `netstat` to every local user, so
  the CLI, the mod and the Pi and opencode extensions send nothing while the file's `pid` runs no
  more (#570). Windows never runs the agent's shutdown when the task is stopped, since that
  terminates it, so the agent also removes the file on SIGHUP (its console closing), SIGBREAK and
  any exit, and setup removes it after ending the agent; a stale `agent.port` stays possible
  after a hard kill, which the `pid` check covers.
  `icacls` gives the file to its user only, as the 0600 mode does the socket. The service is a Scheduled Task
  at the user's logon, registered from a marked XML file in `%LOCALAPPDATA%\starbridge` with the
  ScheduledTasks cmdlets: it needs no administrator, unlike a Windows service, and restarts on
  failure, unlike the `Run` registry key. It runs the agent under `conhost.exe --headless`, since
  a console program opens a window, with no time limit, since a task stops after 3 days by
  default, and logs to `agent.log` beside the XML. A second trigger starts it every 5 minutes
  when it is not running, since conhost may not pass a crash on as a failure. Stopping the task
  ends conhost, so setup also ends the agent, by the pid the agent reports through a proven
  call, never a pid read from the file. A task carries no environment of its own, so the agent
  reads the user's: `STARBRIDGE_CONFIG_DIR` and `CODEX_HOME` reach it only as user environment
  variables. Windows has no SIGTERM: a stopped hook dies without settling its prompt, and the
  next `Stop` hook settles it.
- **Presence** (#848), opt-in per machine with `starbridge config presence on`, since a machine
  reports when its owner is at it: every 10 s the agent reads the screen's lock and the time
  since its last input, the number the OS keeps for its screensaver, and sends the server only
  "present" (unlocked, input in the last minute) or not, again every 30 s while present. macOS
  reads `ioreg` (`CGSSessionScreenIsLocked`, `HIDIdleTime`); Windows keeps one PowerShell
  running, since each start costs about a second of CPU, for `GetLastInputInfo` and whether the
  lock screen (`LogonUI`) runs in its session; Linux takes logind's active graphical session and
  its `LockedHint`, and GNOME's idle monitor or `xprintidle`, since logind's `IdleHint` flips only
  after the desktop's idle delay, minutes. A headless box finds no graphical session and sends
  nothing. Nothing reads what is typed.
- **Answers on the machine** (#260). A machine accepts an answer only from a device the question
  was sealed to, only while it is open, and for an `answerIn` question only a Done, when it asked
  for one (#539). A settled question's
  answer is never delivered, since a server could hold an answer back until the agent moved on.
- **Following every answer** (#629). `answers --all --follow` gives an orchestrator the owner's
  answers to every session's questions, so it no longer depends on each session relaying them or
  reads the state file. It is an observer: it marks no answer seen and no decision waiting, so
  each answer still reaches its session. The machine keeps each decision's project and session
  title, like its question, after the answer drops its body. `decisions --open` lists the
  questions still open, so one question has one asker: the orchestrator checks it before
  asking, since the owner once got the same question from it and from a session.
- **Pairing a machine.** `pair` uses starbridge.run unless `--server` or `STARBRIDGE_SERVER` says
  otherwise (#154). `pair --force` keeps the machine's server and name (#245) and leaves the old
  pairing active, so Devices shows the added time on rows that share a name (#287). `pair` and
  `setup` guess `machineKind` (cloud, laptop with a battery, server with no display, else desktop);
  `config machine-kind` corrects it.
- **Setup names no server question** (#749). Almost everyone uses starbridge.run, and
  `Starbridge server: [https://starbridge.run]` did not read as "Enter for the default". Setup
  takes the first of `--server`, `STARBRIDGE_SERVER`, the server baked into the install script,
  the machine's pairing, and starbridge.run, and prints `Pairing with <host>`. It asks only when
  the machine is paired with another server, since it would otherwise switch silently; Enter
  keeps the pairing.
- **The pairing link** `https://starbridge.run/pair#CODE`, which `pair` prints and shows as a QR
  code, is also an App Link (#611): setup says to scan it with the camera, and a phone's camera
  hands links to apps, not to a browser that would first ask to become a device itself. The app
  opens Add a device with the code looked up, once the phone is in the account; a phone signed in
  but not in the account yet joins with it instead, as another device's "Scan with the new phone"
  code asks. Without the app,
  or on a self-hosted server, which the APK cannot claim, the link opens the web page as before,
  and a phone signed in to another server than starbridge.run hands a starbridge.run link to the
  browser, since its own server would know no such code (#722); where both the installed web app and the app claim it, Android opens the verified app.
  A link from another server that this one doesn't know names that server, "This code is from
  starbridge.run, and this phone is signed in to …", instead of "No pairing with this code"
  (#671). Only a failed lookup says it, since a server can answer under several names.
- **Setup** (`cli/src/setup/`; #68, #239, #245) installs CodexBar's latest release, taking the
  static musl build where the glibc one would not start. Only the repository is pinned, since
  CodexBar ships almost daily (#530): the tarball must match the `.sha256` of the same release,
  as Homebrew checks it, and `starbridge update` moves that install to the latest release too.
  The latest version comes from where `releases/latest` redirects, not GitHub's API, which allows
  60 unauthenticated requests an hour per address, few behind a shared NAT on launch day; the
  download says its size and how far it got every 5 s, since the Linux tarball is 170 MB (#618).
  `update` goes on to CodexBar when its own download fails, offline say, but not when a release
  does not check out (#617).
  `update --codexbar <version>` installs one release, for when the latest breaks; a broken
  CodexBar already shows as each provider's quota error, so there is no other rollback. A daily
  workflow installs the latest release and reads its output without credentials, and opens an
  issue when it breaks. A provider works when `usage
  --provider X` returns windows; CodexBar exits 1 with the reason in its JSON row, so setup reads
  the row. The unit runs the `starbridge` on the PATH when that is the running binary, since that
  path survives brew upgrades. Setup turns on plugin auto-update through `extraKnownMarketplaces`,
  installs the Claude Code plugins only from a marketplace whose source is this repository (#274),
  and Codex's skill and rule, the Pi package and opencode's plugin and skill from copies the CLI
  carries so versions match. The local agent rewrites outdated copies when it starts.
- **Setup asks little** (#750). Each question was one more Enter between a new user and their
  first answer, and nearly everyone said yes. Setup installs Starbridge in every agent it finds
  and starts the service without asking, one line per agent with what it installed; for Codex,
  which loads no rules, it links the rules to paste at the end, with the commands, so nothing
  mid-output reads as a prompt. Claude Code and Pi, whose installs run for seconds, first print
  `installing…` (#773). It still asks before installing CodexBar, a
  third-party binary (with #748, only when no other machine sends quotas), which providers to
  send, whether to linger, and whether to send a test decision. Permission prompts and presence
  stay off and unasked; the summary names `starbridge config permissions on`, on a desktop or
  laptop `starbridge config presence on`, `starbridge status`,
  `starbridge uninstall --agent <name>` and `starbridge uninstall`. With no terminal every
  question takes its default, so nothing waits on input. A failed install prints its reason and
  `starbridge setup --agent <name>`, and setup goes on. Every step after pairing needs the
  server, so setup checks the server and the pairing first (#774): a machine the server no
  longer lists, revoked or lost with the server's database, is offered to pair again (`[Y/n]`,
  what `pair --force` does), and an unreachable server stops setup with the command to retry.
  `uninstall --agent` records the agent,
  and setup and `--refresh` leave it out until `setup --agent` brings it back. An
  agent installed after setup gets nothing in the background: `status` names it, and `setup
  --refresh`, which `update` runs, installs it. The output is plain and lined up, as
  well-known install scripts print theirs: a blank line before each title, a mark in column 1
  (✓ done, ✗ failed, – skipped), agent names in one column, commands on their own line.
- **The CLI's path** (#612). Hooks and plugins start the CLI from an agent whose PATH may lack
  the install folder: on macOS `~/.local/bin` is not on the default PATH, and Claude Code opened
  from the Dock has no shell profile. So setup and `update` record the binary's absolute path in
  the config folder (`cli-path`); the Claude Code hooks (`plugin/hooks/cli.sh`), the mod, and the
  Pi and opencode plugins start that one, else `starbridge` on the PATH, and `cli.sh` then tries
  the installers' folders. When the binary's folder is not on the PATH, setup offers to add it to
  the shell's startup file (`--yes` adds it), and its last lines say to open a new terminal or what to add, since
  install.sh's own hint scrolls away under setup. Windows gets the folder on the PATH from
  install.ps1.
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
  without evidence, or from a shell tool under another name, goes to the owner. `starbridge run` is left out,
  since the command it wraps is the agent's own. So Codex asks at the keyboard to run it outside
  the sandbox, and the skill has it ask on the first call: run in the sandbox first, the command
  ran unreported, then again once approved (#831). A `prompt` rule only adds an approval: Codex
  still runs the command in the sandbox first. Uninstall removes exactly what setup added.
- **Docs** (#211) at `/docs` are the repository's Markdown files listed in `web/src/lib/docs.ts`,
  rendered by the web page. Links between them become `/docs` links; other relative links go to
  GitHub. Images are screenshots under `web/public`, served from the site root, so GitHub shows
  the same file; a `-light` one comes with its `-dark` twin, shown by the page's theme (#558). The Overview's Start ends at a
  first question answered from an agent, and the FAQ page holds the launch questions (#558).
- **The CLI's agent-facing contract is stable from 0.1.0** (#475, #551): the commands, flags,
  output lines and exit codes in `cli/CONTRACT.md`, kept apart from the user-facing CLI page
  (#565), pinned by
  `cli/test/contract.test.ts`. A release may add to it; changing or removing anything listed comes
  only after a release that deprecates it, since the plugins, the Pi extension and agents'
  instructions update apart from the CLI. `--json` always means an output format (`wait --json`); `ask` reads its input with
  `--input <path>`.
- **Install and update.** `https://starbridge.run/install.sh` is `cli/install.sh` as the web
  page serves it, so each deploy serves its own revision's script. Each server writes its
  `PUBLIC_URL` into its copy, and install.ps1's (#749), so `curl -fsSL https://my.host/install.sh
  | sh` pairs with my.host, and a self-hosted landing page shows its own commands. The web
  container reads `PUBLIC_URL` when it runs, so one image serves any server; only a plain
  http(s) origin goes into the script. It checks `SHA256SUMS` with
  minisign, or OpenSSL 3 when minisign is missing. `starbridge update` replaces script installs
  and points Homebrew and npm installs at their manager. Windows refuses to replace or delete a
  running `.exe` but lets it be renamed, so `update` moves it aside to `starbridge.exe.old` and
  the next update removes that; `uninstall` deletes the binary from a detached cmd.exe two seconds
  after it exits (#552).

## Harnesses

### How an answer comes back

An agent posts a question, keeps working and ends its turn; the answer arrives as a new prompt.
Where nothing can deliver a prompt, the agent runs `starbridge wait <id> --timeout 5m` before
ending its turn. `ask` prints which of the two applies (#203). `wait <id>` marks the decision
waiting, which notifies the owner once more; `wait --no-mark` collects the answer to a question
that blocks nothing yet, such as one for tomorrow, without that (#603). A `wait` without an id, run in an
agent's session, takes only that session's answers (#324). `ask` promises a prompt in Claude Code
only when that session's mod called the local agent within the last 45 s (#537); after `/clear` the mod's
hello under the new id names the old one (`replaces`), which then no longer counts. An installed plugin is no proof,
since a session started before it, or one whose mod failed to load, has none; without an agent,
the poller's lease says only that some session runs a mod. When unsure, `ask` prints the `wait`
line, the safe side: at worst a prompt repeats an answer the agent already read.

| Harness | Delivery |
|---|---|
| Claude Code: terminal, desktop app's Code tab, IDEs | The mod (`mod/`) long-polls the local agent's socket in 25 s cycles and submits each answer with `$.prompt.submit` |
| `claude -p`, Agent SDK scripts | `wait`: the run ends with its last turn, so the mod starts no loop there (#321) |
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
- **Which sessions run the mod's loop** (#863). Claude Code tells a mod whether a person is at
  the prompt, and says no both for `claude -p` and for sessions a host such as Claude desktop's
  Code tab or an IDE runs through the SDK. The mod tells them apart by `CLAUDE_CODE_ENTRYPOINT`:
  it starts its loop in an interactive session, or one whose entry point is set and is not
  `sdk-cli` (`claude -p`), `sdk-ts` or `sdk-py` (Agent SDK scripts). A loop in a run that ends
  early costs nothing, since `ask` still prints the `wait` line for an unattended session.
  `starbridge status` run from a session whose mod never called says so.
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
- A card cannot approve an action the agent's own guidelines say needs the owner's yes in the
  chat (account settings, external messages, purchases, deleting data): its answer reaches the
  agent as tool output. The agent asks in the chat, or the card says the yes must come there
  (#680).
- There is no Starbridge rules file (#126). Users tell agents what else to ask or report in the
  agents' own instruction files; `docs/tell-your-agents.md` says where.
- `evals/skill` checks the skill with real sessions of each harness on the smallest models.

### The harness's own ask tool

- Claude Code (#848): the picker races the devices, as permission prompts do. The question shows
  in Claude Code's own picker (terminal, desktop app, the Claude app through Remote Control) and
  on the devices at once; the first answer wins and the other side is settled `elsewhere`. Until
  #848 a `PreToolUse` hook answered the call with "ask through `starbridge ask`" (#121, #200), so a
  quick question at the desk still went only to the phone. The picker is a permission dialog, so
  the plugin's `PermissionRequest` hook takes it whatever the permissions setting: one waiting
  card per question, held from the session's answer loop, and once each has a device's answer it
  allows the call with those answers, which closes the picker (a multi-select answer
  comma-joined, as Claude Code's own). An answer in the picker sends the hook nothing, so
  `PostToolUse` on `AskUserQuestion` settles the cards; Esc sends SIGTERM, as does Claude Code's
  hook timeout, so the hook has its own entry with a day's timeout and withdraws its cards 10
  minutes before it, when no answer could reach the picker any more. The generic
  `PermissionRequest` entry excludes `AskUserQuestion` by its matcher. The `PreToolUse` entry
  stays one release and the new CLI's `hook ask-user` prints nothing, so a newer plugin over an
  older CLI still redirects, and a newer CLI under an older plugin races through the generic
  entry, withdrawing its cards after 570 s.
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
  no `tool_use_id`, so the hook settles a call by the hash of its `tool_input` on `PostToolUse`,
  `PostToolUseFailure` and `PermissionDenied` (a call that runs and fails fires only
  `PostToolUseFailure`, #847), and all of a session's prompts on `Stop` and `SessionEnd`. Both
  tool hooks run a shell check that starts the CLI only while the CLI marks an unexpired prompt
  open (`<config>/permissions-open`, written with the state): starting it on every tool call cost
  about 50 ms and 50 MB, prompts on or off (#517). "This session" and "always" are offered only
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
  on. It goes alone, with no choice. Its field is always open under the options, in the detail
  (web) and the sheet (Android), so typing costs one tap, as a pick does (#849): the owner often
  steers an agent this way ("show me two other mockups"), and a Reply button that opened the field
  made it a second-class answer. Cards in the list keep only the options, so they stay one-tap
  and short. The owner chose this from mockups over a full-width Reply button and a mic in the
  field; the field reads "Your answer" on both clients.
- **Images** (#62, #170, #685): at most 4, PNG or JPEG, never SVG. The CLI keeps a file as is up
  to a 3000 px edge and 384 KB, so a phone screenshot reaches every device unchanged and viewers can zoom into real
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
  machine says it takes one (`done`).
- **Waiting state** (#122, #191, #202). A `waiting` item says whether the agent is blocked on the
  question. A flip either way pushes, so the phone moves the notification between channels. `ask
  --waiting` posts the question quietly and lets its `waiting` item push, so the first
  notification already says waiting.
- **Settling** (#62, #405). `settle` closes a question as `elsewhere` or `withdrawn`. It never
  withdraws one whose answer reached the agent, since devices would hold both. `settle --session`
  and `settle --all` close every open question of a session or of the machine (#584), so a
  flood has a way out; `--all` asks first, with the count. Each is one settled notice, posted at
  the pace the machine's rate limit allows, waiting out each 429: the server needs no bulk
  route, and the notices still reach devices one per question.
- **Snoozing** (#571). The owner can put a question off: "not now, show me this again at 18:00".
  A snooze is not an answer, so #122 holds: for the agent it means what no answer means. Its job
  is less clutter, in the inbox and in the owner's head. Agents are never woken by one; when an
  agent would block, `waiting` and `wait` say until when, and `wait` exits 3 once per snooze, so
  a polling agent stops paying for the wait. The server brings the question back at its time
  from a plain-text hint, so the web, whose service worker cannot schedule, notifies as Android
  does; it learns only that some question was put off until then. Permission prompts and runs
  can't be snoozed: a prompt's answer window is 10 minutes and the keyboard already takes it.
  Agent-suggested times and event snoozes ("until the run ends") were dropped: a snooze is when
  the owner has time; when the agent needs the answer is its waiting state.
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
- **Title and command** (#805). A prompt's title is what the agent says the call does (Claude
  Code's `description`), else the tool, on every surface; the command shows under it in a dark
  terminal block. Allow covers the command, never the description: the agent writes the
  description, so it can mislead. A notification draws the block in its expanded view only, a
  decorated custom view, since the standard templates strip a background colour from text.
- History says how and where a prompt was answered ("Denied · on Pixel"), from the machine's
  `settled` notice (#349).

### Runs

- `starbridge run --title <t> --reason <r> -- <command>` (#60). The reason is required: it tells
  the owner why this run is theirs to watch. The run posts its start, its first progress right
  after it, later progress at most every 10 s, a heartbeat every minute and its exit; a first
  progress held back 10 s left a run that opens on `[0/5]` with an indeterminate bar (#828).
  Output goes through a pipe, so tools that print progress only to a terminal show none.
- Devices call a run lost 3 minutes after its last update (#190, #249); the server cannot read a
  sealed run, so this is client-side. A lost run shows "Lost, no news for 3 min 37 s" and no
  elapsed time, since its last news may predate most of its life. A run with no progress shows an
  indeterminate bar.
- Runs sit above the questions in their own section, open by default, which each device
  remembers open or closed like Snoozed and History (#835): many runs at once pushed the
  questions off the first screen. Closed, its head still counts the runs and names failed and
  lost ones, failed in red, so closing it never hides a failure.
- Finished, failed and lost runs stay 30 minutes, unless the owner dismisses one (#827).
  Dismissing deletes it from the server, so it leaves every device on its next read; a running
  run offers no Dismiss, and one whose machine posts again comes back. Android also keeps a
  dismissed run out locally until a newer update, so a server without the route still hides it
  on that phone.
- Android shows a notification per run, a Live Update on Android 16; dismissing a run closes it.
  The web polls every 2 s while a run is live and the page is visible, else every 10 s.

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
- **Another machine already sends them** (#748). Two machines often read the same accounts, so
  when another active machine of the account posted a snapshot in the last day, setup names it
  and asks whether to send from this machine too, Enter saying no: `devbox already sends quotas.
  Send from this machine too? [y/N]` under the Quotas title. The server says which machines post snapshots and
  when (`GET /v1/quota/senders`), never what they hold. A machine that already sends, or a
  `--providers` list, skips the question. Telling identical accounts apart across machines waits
  for a CodexBar account fingerprint.
- **No snapshot yet** (#661). A snapshot is sealed to the devices active when it is taken, so a
  device that just joined reads none until the next upload, and quota items send no push. The
  agent posts one when it sees a device join; the Quotas screen with nothing to show also asks
  the machines once, as a pull does, and says "Loading quotas from <machines>…" meanwhile. Only
  when nothing comes back does it give the setup line, and with no machine it says to add one.

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
- **Snoozed** (#571, #692, #699). Snooze sits under the reply field in a question's detail (web)
  and sheet (Android), never on a notification. Most snoozes are for later the same day, so it opens on
  today: 1 hour and This evening (18:00, offered until 17:00), then the days as chips (today and
  the 7 after it) and a time an hour ahead, up to the half hour (9:00 on another day), from 5
  minutes on, confirmed by "Snooze until 15:00". Android sets the time on a dial; the web types
  it, to the minute, in the browser's time field, whose 12 or 24 hours follow the browser's
  language rather than the Clock setting. Phones open the times in place under Snooze; the
  desktop web opens them in a popover. A
  snoozed question leaves Needs you, the count and the badge, and its notification closes on
  every device; it waits in a collapsed "Snoozed · n" group after them, soonest back first, its
  time slot "Until 18:00", with no amber and no answer buttons even when its agent waits. Opened,
  it says "Snoozed until …" and offers Snooze again (replaces the time) and Back now. At its time
  it returns to its place and notifies once, "Back from snooze", never again. The owner chose
  these from mockups.
- **History** lists answered questions and the last 7 days of prompts, with how and where each was
  answered.
- **Closed sections wait at the bottom** (#662, #682). Closed, History sits at the bottom of a
  short inbox and Snoozed just above it, out of the way; opened, each glides up under the items
  and its rows fade in. Opening Snoozed leaves History at the bottom.
- **Find** matches every word in the machine, repo, the agent's words, the session and a History
  item's answer. On the web it lists open matches, then History's; Android uses Material 3's
  search view.
- **Answer buttons** (#138, #166): "Answer buttons on questions", Always (default), When the agent
  waits, or Never, applies under 1100 px. More than two options, or a label over 18 characters,
  stack. `answerIn` and typed-only questions have no buttons.
- **Typed answers** (#562): Enter sends, Shift+Enter starts a new line, on the web and with an
  Android hardware keyboard. An Enter that ends an input method's composition only commits it.
- **Context** renders line breaks and code, inline and fenced. Other Markdown shows as typed; the
  skill says so rather than the clients growing a renderer.
- **Revoked machines.** Their items leave the Inbox and their notifications close (#344).
- **Clock** (#161): System, 12-hour or 24-hour, per device. UI words stay English.
- **Images** open a full-screen viewer (zoom, pan, swipe or arrow keys between images) and carry
  an expand badge, since nothing else tells a touch screen they open (#170).
- **Image rows** (#536). A question's images go two to a row, both at one height and each as wide
  as its shape asks, together filling the row (at most `size.media` tall): no grey bands, no
  crop, no frame. With one image per option, two or more, each image sits over its option's
  button in equal columns, in the agent's order: its own shape, no wider than the button and at
  most `size.pick` tall, the row's images centred on one midline so the buttons line up. The owner
  chose both from mockups. The reply field sits under them, as under plain options.
- **Signed out.** A browser that holds no device of the account it last signed in to gets the
  landing page at `/`, as does a revoked browser (#209); one with a device gets sign-in.
- **Restarts go unnoticed** (#250). Clients retry a 502, 503 or refused connection quietly for
  20 s. A write retries only when it cannot have landed; the web's writes retry on 502 and 503
  only, since it cannot tell a refused connection from a cut one.
- **Rate limits** (#645). A 429 with `Retry-After` (seconds or a date) holds every call of the
  page or app until then, first tries included, and the call is retried whatever its method, since
  it was refused before doing anything. A wait past the 20 s retry window reaches the caller as
  429 `rate-limited`. A 429 without `Retry-After` is a cap and reaches the caller at once.
- **Devices.** Rows that share a name show when each was added (#287). A Recovery key row says
  when and on which device the key was set, with Replace; other devices show a replacement once
  (#348).

### Web

- **Security headers** (#312). Next sets a per-request nonce CSP in `web/src/proxy.ts`: scripts
  need the nonce or `'strict-dynamic'`, `'wasm-unsafe-eval'` lets libsodium compile, and an inline
  script sets Zod's `jitless`. Styles allow `'unsafe-inline'` (React style attributes), images
  `data:` and `blob:`, `frame-ancestors 'none'`. Every page renders per request, except the
  landing page below. Caddy adds HSTS, `nosniff` and `Referrer-Policy: same-origin`.
- **Landing page HTML** (#694). A request for `/` without the session cookie gets the whole
  landing page from the server, with its own title, description and link preview
  (`public/og.png`), so link previews and crawlers see it and a first visit is never blank. The
  proxy renders it once per origin and serves that copy with a fresh nonce: Next's one thread
  filled near 18 visitors a second (#593), and a copy costs less than a render. With the cookie,
  `/` is the app as before; the page swaps to sign-in when the browser holds a device, after a
  failed sign-in, or on "Use your own server".
- **Back** (#347). Under 1100 px an open item is `/?item=<id>`, its own history entry, so Back
  returns to the list. Dialogs are modal `<dialog>`s, which Chrome on Android closes on Back.
- **Backoff** (#332). All calls in a page share one backoff, 250 ms doubling to 30 s with jitter,
  ended by any answer or the browser's online event. Pollers skip their turn while it waits.
- **Polling without push** (#664). Until a push reaches it, a visible page reads its inbox and
  open prompts every 5 s rather than 20 s, as Android does at 10 s (#445): it cannot tell a browser
  without Web Push from a server that sends none, and the owner may be watching it for a question.
  That is 24 reads a minute per visible page, inside the per-address limit; 100 such pages cost
  about a tenth of a core (#664 has the numbers). A hidden page still reads nothing, except in
  the desktop app, which notifies from its inbox and prompts and so reads them while hidden (#886).
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
- **Snooze straight on a time** (#692): the times in "Both clients", "Snoozed", with the dial.
  The owner chose this from mockups over a typed time and a grid of half hours.
- **Swipe right to snooze** (#692). A question's card swiped right past 40% of its width snoozes
  it for the time set under "Swipe right on a question": 1 hour (the default), 3 hours, tomorrow
  morning, or Ask for a time, which opens the times over the inbox. A snackbar offers Undo, which
  brings the question back. Let go earlier and the card springs back. The owner chose one
  direction and a set time, so a snooze is one gesture; asking stays a setting. Screen readers
  get a Snooze action instead.
- **Presence** (#848). The app in front and touched in the last minute holds the other devices'
  pushes, as a web page in use does: the owner chose this, since a phone in hand is a screen in
  use as much as a Mac. It counts a touch or key down, never which. Settings → Notifications
  sets the account's hold time, as the web's Settings does.
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
  `cli/minisign.pub`), `install.sh`, `install.ps1`, and notes from merged PRs. `-rc` tags are prereleases and go
  to npm under `next`. Non-rc tags commit the formula to `T0mSIlver/homebrew-starbridge`. npm
  takes the package through Trusted Publishing: the `npm` job trades its GitHub OIDC token for a
  publish token, so no npm token exists to leak or expire, and `npm publish --provenance` adds
  provenance. npm's trusted publisher must allow `npm publish`, not only staging. When a tag's npm
  job fails, a manual run with `npm_only` publishes that tag to npm alone (#820). npm accepts OIDC
  only from GitHub's runners, so that job ignores `vars.RUNNER` (#146).
  versionCode is `2000000 + MAJOR*1000000 + MINOR*10000 +
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
  skipped jobs still report success. The e2e runs under `.github/watchdog.sh`. A merge to main
  skips the e2e when a run from this repository already passed it on the same git tree, most often
  the pull request's last run on its merge with the commit main then held (#878): a tree fixes every
  file, `ci.yml` included, so that run tested what main now holds. Each passing e2e uploads an
  artifact named after its tree, kept 7 days; when none is found or the lookup fails, it runs. A
  fork's runs do not count, since a fork's pull request runs its own `ci.yml`. Tests point
  `TMPDIR` at one directory per run and remove it (`test-tmp.ts`, #313). A `windows-latest` job
  (#552) runs the CLI's platform tests and starts a built `.exe`; the rest of the CLI suite runs
  there without failing the job until it passes. A private repository skips it, since GitHub's
  Windows runners need a public one or paid minutes.
- **Monitoring.** `uptime.yml` checks `/healthz`, `/healthz/backup` (fails when the last nightly
  backup is over 26 h old) and `/healthz/disk` (under 2 GB free), and opens one `outage` issue.

## The hosted instance

- **Stack** (`deploy/`): Docker Compose with Caddy on the host network, so rate limits see real
  client addresses. Caddy keeps connections to the server open (`keepalive 25s`, below the
  server's 30 s idle close) so TIME-WAIT sockets don't use up ports (#376). A client has 10 s for
  its TLS handshake and its HTTP/1.1 request headers, since every open connection costs Caddy
  memory, the VPS's first limit (#587). Caddy compresses every
  response and the web app none: Next's gzip ran on its one thread and filled it near 18 landing
  page visitors a second (#593). Nightly SQLite backups, kept 7 days (#586).
- **Per-address pages and sign-ups** (#787). Caddy takes 600 page requests a minute per address
  outside `/v1` and `/_next/static`: each is Next rendering, 10 to 17 ms of CPU, and a visit with
  its link prefetches makes a few dozen. The server makes at most 30 new accounts an hour per
  address: each account may store 256 MB, so many GitHub accounts behind one script could fill
  the server's 2 GB, while an office or a carrier's NAT signs up a handful an hour.
- **Ready for Cloudflare's proxy** (#799). starbridge.run's DNS is on Cloudflare in DNS-only
  mode; its proxy is the emergency answer to a flood from many addresses, which no per-address
  rule stops. So that turning it on changes nothing else: Caddy takes the client's address from
  `CF-Connecting-IP` only on requests from Cloudflare's published ranges, and every rate limit,
  the block list, the server's per-address limits (through `X-Forwarded-For`, which Caddy sets to
  that address alone) and Umami use it; and long-polls return within 90 s, under the proxy's
  100 s cut. Clients already treat a cut long-poll, or Cloudflare's 524, as a reconnect.
- **Per-address reads** (#582). Caddy counts every `/v1` request per address, 3000 a minute
  (IPv6 per /64): most reads count against no account, so this keeps a looping client or script
  to about 2% of a core. A visible page with a prompt waiting and a run live makes about 200 a
  minute and a heavy user about 600, so five heavy users can share an office's address.
- **Capacity** (#301, #625). On the production stack capped to the VPS's two cores and 4 GB,
  memory runs out first: each signed-in user with a machine and an open page holds two
  long-polls, which cost about 300 KB in Caddy, 60 KB in the server and 55 KB in docker-proxy
  (Caddy's hop to the server's published port), so about 5000 such users fit; CPU stays under
  one core. A new visitor to the landing page costs about 50 ms of CPU across Next and Caddy
  once Caddy compresses (#593), so the VPS serves 15 to 20 a second.
- **Machines** (#658). A hosted account takes 3 machines, the computers that run agents, and any
  number of phones and browsers; self-hosting sets its own (`MAX_MACHINES`, default 5). Each
  machine holds a long-poll, about 200 KB on the VPS, and 3 covers a laptop, a desktop and a
  server. Raising it later is a setting nobody notices; lowering it would strand accounts above
  it. Devices need no cap of their own: the directory holds at most 200 entries, an account's
  pages hold at most 16 join-list long-polls, and Caddy limits each address's requests (#582).
  Every item's text is sealed once per device, so its size grows with their number: a run update
  is capped per device for that reason, and a question with 8000 characters of context fits up to
  about 140 devices in its 2 MB. Its pictures are stored once whatever the number (#685), and
  shrink only to leave the boxes room.
- **Watching it** (#782). Caddy keeps no access log, so the server logs one line a minute of its
  refusals by status, error code and route, with the accounts refused most, and never an
  address. Per-address request and 429 counts stay in its memory, like the rate limits, and only
  the host reads them, through the container's own loopback (port 8081, `GET /watch`). The launch watcher (`deploy/watch/`) reads
  those, `ss`, `docker` and `bun server.js top` over SSH every few minutes and names an address
  only when it holds over 200 connections or is being rate-limited (the owner's rule): at
  Caddy's cap of 3000 `/v1` requests a minute (2900 seen by the server, since Caddy logs no
  refusal), or refused with 429 by the server: an HTTP/2 client can flood over few connections, and every
  other visitor's address would end up in the on-call session's transcript.
- **Blocking an address** (#783). The owner can refuse an address or range at Caddy, by a reload
  that keeps open connections (`deploy/host/switch.sh`), with a 403 that names abuse@. An IPv6
  address is blocked as its /64, as the rate limits count it, and nothing wider than a /8 (IPv4)
  or /32 (IPv6) is accepted. The block list is the one place an address is written to disk, until
  it is unblocked; `/privacy` says so.
- **Suspending an account** (#785). The owner can suspend one account whose machines flood the
  server (a looping agent, or abuse) without deleting it: its machines' writes get 403
  `account-suspended`, which the CLI prints with its reason, while they still read and wait, and
  its phones and browsers work as before, so its owner can still answer, settle and revoke.
  `bun server.js suspend|unsuspend ACCOUNT`, stored as `accounts.suspended_at` (migration 2).
- **Limits at runtime** (#786). The owner can tighten or loosen a rate window or a cap without a
  deploy (`bun server.js limits set items 60/60`, `set maxMachines 4`, `unset`, `reset`): the
  overrides sit in `limits.json` beside the database, which the server reads every minute, so they
  survive restarts and deploys until unset. Retention periods are left out, since shortening one
  deletes data at the next sweep. A file that does not parse keeps the limits as they were.
- **Privacy and terms** (`/privacy`, `/terms`). Each claim follows the code: stored columns in
  `server/src/db.ts`, retention in `server/src/limits.ts`, logs and backups in `deploy/`. A change
  to what is stored changes the page, and the Play data-safety form. Contact is
  privacy@starbridge.run; abuse@ appears only in `/terms`.
- **Analytics** (#141). Umami, self-hosted, on the landing page, the docs, `/privacy` and `/terms`
  only. No cookie, no stored IP, a daily salt, Do Not Track honoured, so no consent banner. The
  Android app has none (Play data safety form). Caddy rate-limits its open endpoint, and an hourly
  timer keeps each table to 180 days and a million rows, so it cannot fill the disk (#574).
- **Launch funnel** (#559, #590). Landing view, a sign-in click, first sign-in, recovery key
  saved, first machine, first answer (with its kind: choice, text or Done); a second device is
  counted beside it. The signed-in app loads no tracker: the browser that created an account posts
  those events itself, once each, with `/` as the page and nothing about the account
  (`web/src/lib/funnel.ts`); Umami joins them to the landing visit by address, browser and day.
  For every signed-in user it sends only which error screen showed and an install as an app.
  The first sign-in's time matches the account's creation, so the operator could link the two;
  `/privacy` says so.
  It sees machines and answers from any device, so a pairing or answer made on the phone counts
  once this browser sees them. Owner's view: an Umami share link on `stats.starbridge.run`,
  where Caddy passes only GET requests and blocks the login. A password (user `tom`) guards the
  whole host, since the link alone would open it to whoever saw it; bcrypt cost 10 and a limit of
  300 requests a minute per address keep its checks from spending the box's CPU (#595). With no
  password set, the pages and the API both stay shut (#717).
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
  Starbridge states 2.1.287, the oldest the mod works with, as its minimum, and setup says when
  `claude --version` is older, since an older one may lack mods or `claude plugin list --json`
  (#620).
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
  Round 2 (#624): a card that blocks nothing was still marked waiting until the skill said
  "post without `--waiting`" beside `--no-mark`, and GLM Flash put its pick first until "even
  when your pick is not first". Records: `evals/skill/results/624`.

## Open questions

- Should cloud sessions get a machine? The agent can read its key from the environment.
- Android App Links on starbridge.run, on top of PKCE, would close the hostile-app sign-in gap for
  the hosted domain (#34).
- Does Safari on iOS lose X25519 keys as WebKit does (#116)?
- Tap targets under 44 px and contrast under 3:1 are listed by the layout checks, not failed,
  until a ruling (#305).
- An offline banner on the web (#332).
- Revoking the old machine in a `pair --force` approval would need a `replaces` field (#287).
