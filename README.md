# Starbridge

Know the moment your agent is stuck.

When a coding agent needs a decision from you, Starbridge puts the question on your phone and in
your browser. You answer with one tap, and the waiting session carries on with your answer as its
next prompt. You also follow the runs that affect you, such as a release or heavy work on your
machine. It also shows what's left on each AI plan, read from CodexBar, with an optional alert
before a window runs out.

Your phone, browsers and machines encrypt everything they send each other, so the server stores
your content only as ciphertext; it still sees who sent each item, to which
devices, its kind, size and times.
[What the server sees](https://starbridge.run/docs/faq#what-does-the-server-see) has the details
and the limits. Use the free server at [starbridge.run](https://starbridge.run), or host your own.

<!-- Demo video: drag the short MP4 into GitHub's README editor here, under the intro. -->

Launch week: [known issues](https://github.com/T0mSIlver/starbridge/issues?q=is%3Aissue%20label%3Aknown-issue).

## Get the app

- **Android:** the signed APK from [GitHub Releases](https://github.com/T0mSIlver/starbridge/releases),
  or add the repository to [Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/T0mSIlver/starbridge)
  to get updates. The APK is signed with the same key as the Google Play build, so a Play install
  later updates it in place.
- **Google Play:** in closed testing. Google needs 12 testers for 14 days before the app can be
  public. To help, join [the testers group](https://groups.google.com/g/starbridge-testers) with
  your phone's Google account, then [become a tester](https://play.google.com/apps/testing/dev.starbridge.app).
- **iPhone:** web app, native app is planned. Open [starbridge.run](https://starbridge.run) in
  Safari and add it to the Home Screen to get notifications.
- **Any browser:** [starbridge.run](https://starbridge.run).

## Install the CLI

Sign in at [starbridge.run](https://starbridge.run) or in the Android app, then install the CLI
on each machine that runs agents:

```bash
curl -fsSL https://starbridge.run/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://starbridge.run/install.ps1 | iex
```

Or with Homebrew:

```bash
brew install T0mSIlver/starbridge/starbridge
```

Or with npm:

```bash
npm install -g starbridge
```

The script runs `starbridge setup`, which pairs the machine, installs Starbridge in each agent it
finds and ends by sending a test question to your phone. After Homebrew or npm, run
`starbridge setup` yourself. [Start](https://starbridge.run/docs#start) goes on to your agent's
first question.

## What each agent supports

| | Claude Code | Codex | Pi | opencode |
|---|---|---|---|---|
| Questions | ✓ | ✓ | ✓ | ✓ |
| Answers into the live session | ✓ | ✓ | ✓ | ✓ |
| "Waiting for you" | ✓ | ✓ | ✓ | ✓ |
| Runs | ✓ | ✓ | ✓ | ✓ |
| Permission prompts | Opt-in | No | Opt-in | Opt-in |
| The agent's own ask tool | ✓ | n/a | n/a | ✓ |
| Rules for when to ask you | ✓ | [Paste them](https://starbridge.run/docs/tell-your-agents#rules-for-codex) | ✓ | ✓ |

In Claude Code, the answer arrives through a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview), code that
runs inside Claude Code: it submits your answer into the live session as its next prompt. Setup
installs it beside the Starbridge plugin.

Answers go into interactive sessions; Codex needs CLI 0.160 or later. In `codex exec`, `pi -p` and
`opencode run`, the agent waits for the answer with `starbridge wait` instead.

[What each agent supports](https://starbridge.run/docs/tell-your-agents#what-each-agent-supports)
lists the version and setup each one needs.

## Docs

[starbridge.run/docs](https://starbridge.run/docs): getting started, the CLI, telling your agents
when to reach you, self-hosting, and the [FAQ](https://starbridge.run/docs/faq), with what the
server can and can't see.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
