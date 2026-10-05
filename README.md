# Starbridge

Your agents ask. You answer from anywhere.

When a coding agent needs a decision from you, Starbridge puts the question on your phone and in
your browser. You answer with one tap, and the waiting session carries on with your answer as its
next prompt. You also follow the runs that affect you, such as a release or heavy work on your
machine, and see what each AI plan has left before you start the next agent.

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

The script runs `starbridge setup`, which pairs the machine and installs the Claude Code plugin.
After Homebrew or npm, run `starbridge setup` yourself.

## What each agent supports

| | Claude Code | Codex | Pi |
|---|---|---|---|
| Questions | ✓ | ✓ | Coming |
| Answers into the live session | ✓ | ✓¹ | Coming |
| "Waiting for you" | ✓ | ✓ | Coming |
| Runs | ✓ | ✓ | Coming |
| Permission prompts | Opt-in | No | Coming |
| `AskUserQuestion` hook | ✓ | n/a | Coming |

¹ In interactive sessions while `starbridge agent` runs. In `codex exec`, the agent waits for the
answer before it ends its turn.

## Docs

[starbridge.run/docs](https://starbridge.run/docs): getting started, the CLI, telling your agents
when to reach you, and self-hosting.

## Licence

MIT
