# Starbridge for iPhone

The native iPhone app: SwiftUI on [`StarbridgeProtocol`](StarbridgeProtocol), the Swift port of
`packages/protocol`. So far it signs in, sets up an empty account's first device, joins an account
that has one, recovers one with the recovery key, and shows the inbox, where it answers questions
and permission prompts, from the app or from a notification (the plan is
in the planning repo's `research/ios-app.md`).

- **Sign-in** goes through the browser with PKCE, as on Android (PROTOCOL.md, "Auth"):
  `ASWebAuthenticationSession` opens `/v1/auth/github?app=1&challenge=…` and ends on
  `starbridge://auth`, where the app trades GitHub's code and its verifier for the session.
  Self-hosted servers also take the owner token.
- **The first device** follows Android (#370): the app keeps the signed first entry and shows the
  recovery key once; the server gets the entry when the owner says they stored the key.
  **Recovery** with the key adds this iPhone and revokes every other member.
- **Joining** follows Android: scan the QR code that a device already in the account shows, or
  compare digits with it (PROTOCOL.md, "Joining by digits").
- **Keys** and the session are one keychain item, readable after the first unlock and never
  copied to another device; the rest of the state is a file in Application Support.
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
  keychain item's access group, and writes nothing. A button answers through the outbox in the
  background; a prompt's Deny answers there, its Allow opens the prompt. The simulator skips
  service extensions for `simctl push`, so `NotificationServiceTests` drives the extension's work
  (`Notify.rewrite`) against the shared keychain and app group instead.
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
They run when the test process gets a self-hosted server with no device yet, started from the repository root with
`PORT=18731 DB_PATH=/tmp/sb.db OWNER_TOKEN=test bun run server/src/main.ts`:

```bash
TEST_RUNNER_STARBRIDGE_TEST_SERVER=http://localhost:18731 TEST_RUNNER_STARBRIDGE_TEST_OWNER_TOKEN=test xcodebuild -project Starbridge.xcodeproj -scheme Starbridge -destination "platform=iOS Simulator,name=iPhone 16" test
```

CI runs both, with the server, in `.github/workflows/ios.yml`. Builds are for the simulator until
signing lands with the TestFlight upload.
