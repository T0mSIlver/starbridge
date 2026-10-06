# Starbridge

Know the moment your agent is stuck.

When a coding agent needs a decision from you, Starbridge puts the question on your phone and in
your browser. You answer with one tap, and the waiting session carries on with your answer as its
next prompt. You also follow the runs that affect you, such as a release or heavy work on your
machine. It also shows what's left on each AI plan, read from CodexBar, with an optional alert
before a window runs out.

Your phone, browsers and machines encrypt everything they send each other, so the server stores
only ciphertext. Use the free server at [starbridge.run](https://starbridge.run), or host your
own.

## Install

Sign in at [starbridge.run](https://starbridge.run) or in the Android app, then install the CLI
on each machine that runs agents:

```bash
curl -fsSL https://starbridge.run/install.sh | sh
```

Or with Homebrew:

```bash
brew install T0mSIlver/starbridge/starbridge
```

Or with npm:

```bash
npm install -g starbridge
```

The script runs `starbridge setup`, which pairs the machine and installs Starbridge in each agent
it finds.
After Homebrew or npm, run `starbridge setup` yourself.

## What each agent supports

| | Claude Code | Codex | Pi | opencode |
|---|---|---|---|---|
| Questions | ✓ | ✓ | ✓ | ✓ |
| Answers into the live session | ✓ | ✓ | ✓ | ✓ |
| "Waiting for you" | ✓ | ✓ | ✓ | ✓ |
| Runs | ✓ | ✓ | ✓ | ✓ |
| Permission prompts | Opt-in | No | Opt-in | Opt-in |
| The agent's own ask tool | ✓ | n/a | n/a | ✓ |

[What each agent supports](https://starbridge.run/docs/tell-your-agents#what-each-agent-supports)
lists the version and setup each one needs.

## Docs

[starbridge.run/docs](https://starbridge.run/docs): getting started, the CLI, telling your agents
when to reach you, and self-hosting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
