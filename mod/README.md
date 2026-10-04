# Starbridge mod for Claude Code

When the owner answers a decision, this mod submits the answer into the Claude
Code session that asked, as the line `starbridge wait` prints:

```
Answer to d_Xk3… (Merge #12 now?): Merge
```

It works in the terminal, the desktop app's Code tab and Remote Control.

## Install

1. Install the `starbridge` CLI on the `PATH` that Claude Code runs with, and
   pair the machine (`cli/README.md`).
2. Copy this folder somewhere stable, for example `~/.claude/mods/starbridge`.
3. Add it to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
   `~/.claude/settings.json`. Separate several folders with `:`.

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/starbridge" } }
   ```

   For a single session, use `claude --plugin-dir ~/.claude/mods/starbridge`
   instead.

Sessions started afterwards load the mod. `claude plugin validate
~/.claude/mods/starbridge` checks the folder.

## How it works

The mod holds no keys and makes no network calls. The CLI keeps the machine's
keys, opens and verifies each answer, and records which session asked each
decision (`$CLAUDE_CODE_SESSION_ID` at `starbridge ask`).

- Every interactive session runs the mod, but only one per machine polls: the
  session holding the lease in `~/.config/starbridge/mod-poller.json`. It runs
  `starbridge answers --session <id> --wait 25` back to back, which stays
  under the 30 s limit on calls from a mod.
- The other sessions watch `state.json`. When it changes, they run `starbridge
  answers --session <id>`, which reads local state only.
- `answers` returns only answers to decisions that session asked and that no
  `wait` has printed. It marks each one as printed, so it is handed over once.
- After an error, the mod waits 2 s, then twice as long after each further
  error, up to 5 minutes. The error shows in the status line until a call
  succeeds.
- When a session ends, it gives up the lease and another session starts
  polling. After a `/clear`, the mod uses the new session id.

## Develop

```bash
pnpm --filter @starbridge/mod test
```

The tests run the poller against the CLI and its fake server. `hooks/poller.ts`
holds the logic and `hooks/register.ts` connects it to the engine. CI type-checks
only `poller.ts`. To type-check `register.ts`, load the mod once so the engine
writes its types to `.claude-plugin/types/`, then run `tsc -p
tsconfig.engine.json`.
