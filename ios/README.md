# Starbridge for iPhone

The native iPhone app: SwiftUI on [`StarbridgeProtocol`](StarbridgeProtocol), the Swift port of
`packages/protocol`. So far it signs in, sets up an empty account's first device, joins an account
that has one, recovers one with the recovery key, and shows the inbox, where it answers questions
and permission prompts, from the app or from a notification (the plan is
in the planning repo's `research/ios-app.md`).

- **Sign-in** goes through the browser with PKCE, as on Android (PROTOCOL.md, "Auth"):
  `ASWebAuthenticationSession` opens `/v1/auth/github?app=1&challenge=…` and ends on
  `https://starbridge.run/v1/auth/github/callback/app` (iOS 17.4 and later, through the
  associated domain) or on `starbridge://auth` (older iOS, self-hosted servers), where the app
  trades GitHub's code and its verifier for the session.
  Self-hosted servers also take the owner token.
- **The first device** follows Android (#370): the app keeps the signed first entry and shows the
  recovery key once; the server gets the entry when the owner says they stored the key.
  **Recovery** with the key adds this iPhone and revokes every other member.
- **Joining** follows Android: scan the QR code that a device already in the account shows, or
  compare digits with it (PROTOCOL.md, "Joining by digits").
- **Keys** and the session are one keychain item, readable after the first unlock and never
  copied to another device; the rest of the state is `saved.json` in the app group's container
  (Application Support only without the group), with a question's decrypted images in `images/`
  beside it, both kept out of backups.
- **The inbox** follows spec/clients.md: runs, then permission prompts, then questions whose agent
  waits, then the rest; Snoozed and History closed at the bottom. With no push yet, the app reads
  the server every 10 s while it is in front.
- **Quotas** (#1234) follow Android's tab: one card per provider, in the order and with the bars
  Settings → Quotas sets on this iPhone. APNs carries no quota snapshots, so the app reads
  `GET /quota` with the inbox.
- **Answers** are signed, sealed and kept in an outbox before they are posted, as on Android
  (#329): one tapped offline is sent once the server can be reached.
- **Notifications** (#1137): APNs carries each question as an alert with a placeholder, which the
  notification service extension (`Notifications/`) rewrites from the sealed box: the question,
  its machine and repo, up to 3 options with the agent's default first, and Reply. It reads the
  keys and the pinned directory from the app group `group.dev.starbridge.ios`, which is also the
  keychain item's access group. It registers each question's buttons, sets the notification's
  badge, and keeps what each push did in `notified.json` beside `saved.json`, which the app also
  writes when an answer closes a question, so a late or repeated push rings once (#2151). A button answers through the outbox in the
  background; a prompt's Deny answers there, its Allow opens the prompt. The simulator skips
  service extensions for `simctl push`, so `NotificationServiceTests` drives the extension's work
  (`Notify.rewrite`) against the shared keychain and app group instead.
- **Presence** (#848) follows Android: in front, a touch anywhere in the window or a key typed
  into a field says the owner is here, and only that bit reaches the server.
- **Devices** (Settings → Devices and machines) follows Android: each device's notifications and
  app, a machine's check code while `starbridge pair` asks, Update available, and Revoke. Add a
  device looks up a typed, scanned or linked code before Approve, and proves a machine's check
  key from its QR (#795), or shows a QR code for a new phone. Replace, under the recovery key,
  takes the current key and posts the new one once the owner says it is stored (#348). A join by
  digits from another browser or phone asks over any screen while the app is in front (#1158).
- **Design tokens** are `Starbridge/Theme/Tokens.swift`, written from DESIGN.md by
  `bun web/scripts/tokens.ts`; type is SF Pro, scaled with Dynamic Type.

## Build and test

On a Mac with Xcode 16 or later and [XcodeGen](https://github.com/yonaskolb/XcodeGen), which
writes `Starbridge.xcodeproj` from `project.yml` (edit the YAML, not the project):

```bash
xcodegen generate
```

```bash
xcodebuild -project Starbridge.xcodeproj -scheme Starbridge -destination "platform=iOS Simulator,name=iPhone 16" test
```

`JoinTests` joins an account on a real server, playing the device that approves, and
`FirstDeviceTests` sets up the first device, recovers on a second iPhone, then deletes the account,
and `InboxTests` plays a machine whose question, prompt and run the app lists and answers, online
and offline, then deletes the account.
They run when the test process gets a self-hosted server with no device yet. The suite signs in as
the owner more than the 10 a minute the server allows, so raise that first, then start the server, both from the repository root:

```bash
DB_PATH=/tmp/sb.db bun run server/src/main.ts limits set ownerSignIns 1000/60
PORT=18731 DB_PATH=/tmp/sb.db OWNER_TOKEN=test-owner-token-16 bun run server/src/main.ts
```

```bash
TEST_RUNNER_STARBRIDGE_TEST_SERVER=http://localhost:18731 TEST_RUNNER_STARBRIDGE_TEST_OWNER_TOKEN=test-owner-token-16 xcodebuild -project Starbridge.xcodeproj -scheme Starbridge -destination "platform=iOS Simulator,name=iPhone 16" test
```

CI runs both, with the server, in `.github/workflows/ios.yml`. Each release tag uploads the app to
TestFlight from `.github/workflows/release.yml` (spec/releases.md, "The iPhone app on TestFlight").

### Renew the distribution certificate

The release signs with an Apple Distribution certificate stored in the `ios-release` environment,
valid a year. When a run warns that it expires soon, or that it was revoked, issue a new one with
the CI's App Store Connect key, then store it without printing it:

```bash
ASC_KEY_PATH=AuthKey_<id>.p8 ASC_KEY_ID=<id> ASC_ISSUER_ID=<issuer> ruby ios/scripts/asc-signing.rb issue <private dir>
```

```bash
base64 < <private dir>/distribution.p12 | tr -d '\n' | gh secret set IOS_DISTRIBUTION_P12 --env ios-release
```

```bash
gh secret set IOS_DISTRIBUTION_P12_PASSWORD --env ios-release < <private dir>/distribution.p12.password
```

Then revoke the old certificate in Certificates, Identifiers & Profiles.

## Build on the Mac mini

Agents on the dev box build and test here through one script, not their own rsync and `xcodebuild`:

```bash
ios/scripts/mini.sh test                                   # the whole suite
ios/scripts/mini.sh test -only-testing:StarbridgeTests/InboxTests
ios/scripts/mini.sh build
ios/scripts/mini.sh status                                 # slots, cached worktrees and their sizes
```

It syncs the worktree to `~/sb-cache/src/<key>` on `ssh mini`, runs XcodeGen, then `xcodebuild` with
what the mini keeps between runs under `~/sb-cache`: DerivedData per worktree (the key is the
worktree's name and a hash of its path; `--key` sets one), one SwiftPM cache for all keys, and one
simulator per key, erased before each run (`--keep-sim` skips that and saves about 20 s). Only
errors, failed tests and the totals print; `--raw` prints everything, and the last full log is
`~/sb-cache/logs/<key>.log` on the mini. The exit code is `xcodebuild`'s (124 on the time limit,
`--timeout`, default 1500 s).

At most 2 runs build at once (`SB_MINI_SLOTS`); the next waits and says so. A key's own runs go one
at a time. The locks are kernel file locks held by a process on the mini that dies with the
connection, and `xcodebuild` is killed with it, so a dropped ssh or Ctrl-C frees the slot.

The cache is pruned after each run: the newest 8 worktrees, none unused for 14 days, and 20 GB of
sources and DerivedData together, least recently used first (`SB_MINI_KEEP`, `SB_MINI_MAX_DAYS`,
`SB_MINI_MAX_GB`). `ios/scripts/mini.sh --key <key> clean` removes one key and its simulator. A
test that needs the self-hosted server above passes `--reverse 18731` to forward that port from
the mini to the dev box, and the `TEST_RUNNER_*` variables set where you run the script reach the
tests. XcodeGen 2.44.1 is installed under `~/sb-cache/bin` on first use, checked against CI's
checksum.
