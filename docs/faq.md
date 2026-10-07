# FAQ

## How is it different from ntfy, Pushover or a webhook?

Those deliver a notification. ntfy's action buttons can send a request back, but nothing puts
it into the waiting session, so you still walk to the terminal to answer. Starbridge carries the
answer back: your tap goes into the waiting session as its next prompt. A permission answer
is signed by your device and bound to one call by a hash of its input, so it can't approve a
different command. ntfy can still deliver the notifications, through UnifiedPush on a
[self-hosted server](../server/README.md#notifications).

## Why not the agents' own mobile apps?

Each covers one agent; the Claude app, for example, answers permission prompts for Remote
Control sessions. Starbridge puts the questions of every session, machine and agent in one
inbox, with the runs you follow. It doesn't remote-control the terminal: the agent decides what
is worth asking you, with two to four options.

## How is it different from Happy or Omnara?

Those mirror the whole session so you drive it from the phone. Starbridge carries only the
decisions the agent asks you for and the runs it reports. You keep using the agent as before.

## What does the server see?

Every question, answer, permission prompt, run, quota snapshot, image and link is signed
(Ed25519) and sealed with libsodium's `crypto_box_seal` to each of your devices' keys. Keys are
made on your devices and machines, and the server holds none that opens the items. A machine
pairs with a 24-character code whose secret never reaches the server. The device list is a
signed hash chain that every client pins, so the server can't add a key of its own or roll back
a revocation unseen.

What it does see: your GitHub numeric id, device and machine ids, public keys, the names you
give devices and machines, and each item's kind, id, sender, recipients, the item it answers,
size and times, when a snoozed question comes back, plus push tokens.
It can hold items back or drop them.

The limits:

- The web app is code the server sends on each load, so a compromised server could send a page
  that uses or reads that browser's keys. The Android app and the CLI are installed code. Where
  this matters, use the Android app and no browser, or host your own server.
  [PROTOCOL.md](../PROTOCOL.md#the-web-app-trusts-its-server) says what such a page could do.
- A compromised machine can post anything as itself until you remove it.
- Whoever holds the recovery key can take over the account.
- No independent security review yet. The audits so far were by AI models and by the author.

[PROTOCOL.md](../PROTOCOL.md) has the formats, pairing, the device list and the
[permission security model](../PROTOCOL.md#security-model).

## Does it work with open models?

Yes. Starbridge works at the agent's level, through its plugin or skill, so the model behind
the agent doesn't matter. Quotas read your AI plans through CodexBar; with no plan,
`starbridge setup --no-quota` skips them, and CodexBar with them.

## Which agents, and how well?

Claude Code gets the most: a plugin with rules, a skill and hooks; answers into the live session
through a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview), code that
runs inside Claude Code; its own `AskUserQuestion` sent to your phone; and permission prompts if
you turn them on. opencode gets the same through its plugin, its own `question` tool included.
Pi gets the rules, the skill and answers into the live session through its package, and
permission prompts with pi-permission-system. Codex gets the skill and answers into interactive
sessions, but no rules and no permission prompts. Any other agent can run `starbridge ask` and
`starbridge wait`.
[What each agent supports](tell-your-agents.md#what-each-agent-supports) has the details.

## Do I restart my agents after setup?

Yes: sessions that were running before setup don't have Starbridge. Quit each one and resume it
with its agent's command, such as `claude --continue`; the
[Overview](index.md#sessions-already-running) lists them.

## Which platforms?

The CLI runs on Linux, macOS and Windows, x64 and arm64. Quotas need CodexBar, which has no
Windows build, so a Windows machine uploads none. The app runs on Android, and the web app in any
browser; on iOS 16.4 and later, add starbridge.run to the Home Screen from Safari to get
notifications.

## Do you trust CodexBar's code?

On Linux and macOS, setup installs [CodexBar](https://github.com/steipete/CodexBar) with Homebrew where it is
present, else from CodexBar's GitHub release, checked against the `.sha256` published in the
same release. It installs nothing when the checksum is missing or doesn't match. The check
proves the file is the one the release published; Starbridge doesn't vouch for CodexBar's code.
Your plan credentials stay on the machine, and only the encrypted snapshot goes up.

## What does it cost?

Nothing. starbridge.run is a small VPS the author pays for. The [terms](https://starbridge.run/terms)
promise 60 days' notice before any price and 30 days' notice before a shutdown. Each account
takes up to 3 machines, the computers that run your agents, and any number of phones and
browsers. Self-hosting is free, under the MIT licence.

## What's kept, and for how long?

The server deletes answered questions and their answers 7 days after the answer, permission
prompts 7 days after they arrive, runs a day after their last update, and unanswered questions
and quota snapshots after 30 days, or unanswered questions after 7 days once an account holds
more than 1000. Backups keep deleted data for up to 2 weeks. The
[privacy page](https://starbridge.run/privacy) says how to delete your account.

## Why GitHub sign-in?

People who run coding agents have a GitHub account, and the server stores no password or email:
it keeps only the numeric GitHub id. A self-hosted server can use an owner token instead.

## Why is the CLI 82 MB?

It is TypeScript compiled with `bun build --compile`, so the binary carries the Bun runtime. It
shares the signing and sealing code with the web app and the server. `starbridge --version`
takes about 45 ms, and the background service holds about 35 MB of memory of its own, 80 MB
with the runtime it maps. After each tool call, the Claude Code plugin's hook checks whether a
permission prompt is open, which takes under a millisecond, and starts the CLI only if one is.

## Will the hosted server hold up?

A load test ran the production stack on two cores with the VPS's memory. It holds about 5000
signed-in users and 15 to 20 new visitors a second. The VPS can be resized in minutes.
