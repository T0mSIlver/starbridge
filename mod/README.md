# Starbridge mod for Claude Code

When the owner answers a decision, this mod submits the answer into the Claude
Code session that asked, as the line `starbridge wait` prints:

```
Answer to d_Xk3… (Merge #12 now?): Merge
```

It works in the terminal, the desktop app's Code tab and Remote Control.

## Install

1. Install the `starbridge` CLI on the `PATH` that Claude Code runs with, and
   pair the machine (`cli/README.md`). Install the skill too
   (`skill/README.md`): it tells agents to post and keep working.
2. Copy this folder somewhere stable, for example `~/.claude/mods/starbridge`.
3. To try it in one session, start that session with
   `claude --plugin-dir ~/.claude/mods/starbridge`.
4. To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in
   the `env` block of `~/.claude/settings.json`. Separate several folders with
   `:`.

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/starbridge" } }
   ```

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
  `wait` has printed. When a decision's default time passes with no answer,
  it returns one line for that too:
  `No answer to d_Xk3… (Merge #12 now?) by its default time …: apply your default: Merge`.
  The mod submits each line, then confirms it with
  `starbridge answers --session <id> --ack <ack>`; the CLI hands an
  unconfirmed line over again. Update the CLI and the mod together.
- A session that does not poll also runs `answers` every 30 s when
  `state.json` has not changed, because a default time passing changes no
  file.
- If a `/clear` lands while `answers` runs, the mod submits nothing and leaves
  the answer unconfirmed, so the old session gets it if it is resumed.
- After an error, the mod waits 2 s, then twice as long after each further
  error, up to a minute. The error shows in the status line until a call
  succeeds.
- When a session ends, it gives up the lease and another session starts
  polling. After a `/clear` or a `/resume`, the mod uses the new session id.

## Develop

```bash
pnpm --filter @starbridge/mod test
```

`e2e/run.ts` drives real Claude Code sessions in tmux through each case:
idle, mid-turn, `/clear` and `/resume`, a hot reload, a server outage, two
sessions at once and a default time. It runs against the server app on a
random port (`--local`), or against a real server with a test device
(`e2e/device.ts`) and this machine's CLI config. It needs `claude`, `tmux` and
`starbridge` on `PATH`, and prints one row of timings per case.

The tests run the poller against the CLI and the real server, which
`@starbridge/server/test-support` starts on a random port. `hooks/poller.ts`
holds the logic and `hooks/register.ts` connects it to the engine. CI type-checks
only `poller.ts`. To type-check `register.ts`, load the mod once so the engine
writes its types to `.claude-plugin/types/`, then run `tsc -p
tsconfig.engine.json`.
