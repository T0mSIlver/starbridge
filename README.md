# Starbridge

Your agents ask. You answer from anywhere.

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

The script runs `starbridge setup`, which pairs the machine and installs the Claude Code plugin.
After Homebrew or npm, run `starbridge setup` yourself.

## What each agent supports

| | Claude Code | Codex | Pi |
|---|---|---|---|
| Questions | ✓ | ✓ | ✓ |
| Answers into the live session | ✓ | ✓¹ | ✓² |
| "Waiting for you" | ✓ | ✓ | ✓ |
| Runs | ✓ | ✓ | ✓ |
| Permission prompts | Opt-in | No | Opt-in³ |
| `AskUserQuestion` hook | ✓ | n/a | n/a |

¹ In interactive sessions (Codex CLI 0.160 or later) while `starbridge agent` runs. In `codex exec`, the agent waits for the
answer before it ends its turn.

² In the interactive TUI and RPC mode, with the Starbridge Pi package (`pi install
git:github.com/T0mSIlver/starbridge`). In `pi -p`, the agent waits for the answer before it ends
its turn.

³ With pi-permission-system, once its `authorizerChain` names `starbridge`: your devices allow a
call once or deny it.

## Docs

[starbridge.run/docs](https://starbridge.run/docs): getting started, the CLI, telling your agents
when to reach you, and self-hosting.

## Licence

MIT
