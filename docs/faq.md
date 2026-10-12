# FAQ

## Compared with other tools

### How is it different from ntfy, Pushover or a webhook?

Those deliver a notification. ntfy's action buttons can send a request back, but nothing puts it
into the waiting session, so you still walk to the terminal to answer. Starbridge puts your tap
into the waiting session as its next prompt.

A permission answer is signed by your device and bound to one call by a hash of its input, so it
can't approve a different command. ntfy can still deliver Starbridge's notifications, through
UnifiedPush on a [self-hosted server](../server/README.md#notifications).

### Why not the harnesses' own mobile apps?

Each covers one harness; the Claude app, for example, answers permission prompts for Remote
Control sessions. Starbridge puts the questions of every session, machine and harness in one
inbox, with your runs.

### How is it different from Happy or Omnara?

Those mirror the whole session so you drive it from the phone. Starbridge carries only the
decisions the agent asks you for and the runs it reports, and you keep using the harness as
before.

## Privacy and security

### What does the server see?

Every question, answer, permission prompt, run, quota snapshot, image and link is signed
(Ed25519) and sealed with libsodium's `crypto_box_seal` to each of your devices' keys. Keys are
made on your devices and machines, and the server holds none that opens the items.

A machine pairs with a 24-character code whose secret never reaches the server. The device list
is a signed hash chain that every client pins, so the server can't add a key of its own or roll
back a revocation unseen.

The server sees your GitHub numeric id, device and machine ids, public keys, the names you give
devices and machines, and push tokens. For each item, it sees its kind, id, sender, recipients,
the item it answers, its size and times, and when a snoozed question comes back. It can hold items
back or drop them.

The limits:

- The web app is code the server sends on each load, and the Mac app shows that same page. A
  compromised server could send a page that reads that browser's keys, approves permission
  prompts, or uses a pairing code or recovery key typed into it
  ([what such a page could do](../PROTOCOL.md#the-web-app-trusts-its-server)). The Android app
  and the CLI are installed code. Where this matters, use the Android app and no browser, scan
  machines' QR codes with the app, or host your own server.
- A self-hosted server still sends pushes through starbridge.run's relay unless it has its own
  VAPID keys and uses UnifiedPush ([Notifications](../server/README.md#notifications)).
- A compromised machine can post anything as itself until you remove it.
- Whoever holds the recovery key can take over the account.
- No forward secrecy: whoever later gets a device's or machine's private key and the server's
  stored items opens the items still stored for it.
- Anyone signed in to your GitHub account can ask to join, so approve only a join you started.
- No independent security review yet. The audits so far were by AI models and by the author.

[PROTOCOL.md](../PROTOCOL.md) has the formats, pairing, the device list and the
[permission security model](../PROTOCOL.md#security-model).

### What's kept, and for how long?

The server deletes:

- answered questions and their answers 7 days after the answer;
- permission prompts 7 days after they arrive;
- runs a day after their last update;
- unanswered questions and quota snapshots after 30 days, or unanswered questions after 7 days
  once an account holds more than 1000.

Delete account, in Settings, deletes everything the server holds for your account at once and
signs out every device and machine. The Android app has it from 0.1.5. Backups keep deleted data
for up to 2 weeks ([privacy page](https://starbridge.run/privacy)).

### Why GitHub sign-in?

People who run coding agents have a GitHub account, and the server then stores no password or
email, only the numeric GitHub id. A self-hosted server can use an owner token instead.

## Setup

### Which harnesses, and how well?

Starbridge installs in Claude Code, Codex, Pi, opencode, Cursor and Antigravity
([What each harness supports](tell-your-agents.md#what-each-harness-supports)). Any other harness
can run `starbridge ask` and `starbridge wait`.

### Do I restart my harnesses after setup?

Yes. A session started before setup doesn't have Starbridge: resume it
([Sessions already running](index.md#sessions-already-running)).

### Does it work with open models?

Yes. Starbridge works through the harness's plugin or skill, so the model doesn't matter. With no
AI plan, `starbridge setup --no-quota` skips quotas and CodexBar.

### Which platforms?

The CLI runs on Linux, macOS and Windows, x64 and arm64. Quotas need CodexBar, which has no
Windows build, so a Windows machine uploads none. [Start](index.md#start) lists the apps.

### Why does Starbridge use CodexBar?

A quota window that empties mid-task stalls the agent like an unanswered question, so Starbridge
warns before a window runs out, and before one resets with quota unused.

[CodexBar](https://github.com/steipete/CodexBar), by Peter Steinberger, is open source and already
reads more than a dozen providers' plans, so Starbridge reads its output instead of writing its
own reader; the author contributes to it. It reads plan usage on your machine, and Starbridge
encrypts the snapshot like every other item.

### Do you trust CodexBar's code?

Starbridge checks that CodexBar's output still reads right, but doesn't vouch for its code. Your
plan credentials stay on the machine, and only the encrypted snapshot goes up.

On Linux and macOS, setup installs CodexBar with Homebrew where it is present, else from
CodexBar's GitHub release. Each Starbridge release names one CodexBar release and the SHA-256 of
its files, and setup and `starbridge update` install only that file. A newer CodexBar release
reaches you only with a Starbridge release, unless you pick one with
`starbridge update --codexbar <version>`.

## Cost and scale

### What does it cost?

Nothing. starbridge.run is a small VPS the author pays for. The
[terms](https://starbridge.run/terms) promise 60 days' notice before any price and 30 days'
notice before a shutdown. Self-hosting is free, under the MIT licence.

Each account takes up to 3 machines, the computers that run your harnesses, and any number of
phones and browsers.

### Why is the CLI 82 MB?

It is TypeScript compiled with `bun build --compile`, so the binary carries the Bun runtime, and
it shares the signing and sealing code with the web app and the server.

`starbridge --version` takes about 45 ms, and the background service holds about 35 MB of memory
of its own, 80 MB with the runtime it maps. After each tool call, the Claude Code plugin's hook
checks in under a millisecond whether a permission prompt is open, and starts the CLI only if one
is.

### Will the hosted server hold up?

A load test ran the production stack on two cores with the VPS's memory. It holds about 5000
signed-in users and 15 to 20 new visitors a second. The VPS can be resized in minutes.
