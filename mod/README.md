# Starbridge mod for Claude Code

When the owner answers a decision, this mod submits the answer into the Claude
Code session that asked, as the line `starbridge wait` prints:

```
Answer to d_Xk3… (Merge #12 now?): Merge
```

It works in the terminal, the desktop app's Code tab and Remote Control.

## Install

Install it from the Starbridge marketplace, beside the `starbridge` plugin
(`plugin/README.md`):

```bash
claude plugin install starbridge-mod@starbridge --scope user
```

A Claude Code build or organization that refuses mods skips this plugin and
keeps the skill; answers then wait until a session runs `starbridge answers`.
To try a checkout in one session: `claude --plugin-dir mod`.

## How it works

The mod holds no keys. Each interactive session picks one of two paths, and
switches when the agent starts or stops.

### Through the agent

When the machine's agent (`starbridge agent`, PROTOCOL.md, "Local agent API")
answers on its unix socket, each session talks to it with `$.http.fetch`:

- `POST /v1/sessions/<id>/hello` once per session id, with the session's
  working directory.
- `GET /v1/sessions/<id>/events?wait=25` back to back, under the 30 s limit on
  calls from a mod. The agent hands the session only the answers and
  default-time notices for the decisions it asked.
- The mod submits each event's line, then confirms it with
  `POST /v1/sessions/<id>/ack`; the agent hands an unconfirmed event over
  again. It skips event types it does not know.
- `POST /v1/sessions/<id>/bye` when the session ends.

The socket is `$STARBRIDGE_AGENT_SOCKET`, else
`$XDG_RUNTIME_DIR/starbridge/agent.sock` for the default config directory,
else `agent.sock` in the config directory, as the CLI works it out. A 426 (the
agent speaks another API revision) or a call that cannot connect sends the
session to the CLI path.

### Through the CLI

With no agent, or with `STARBRIDGE_NO_AGENT=1`, the mod runs the CLI, as
before the agent existed, and checks for the agent every 30 s.

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
  unconfirmed line over again.
- A session that does not poll also runs `answers` every 30 s when
  `state.json` has not changed, because a default time passing changes no
  file.
- When a session ends, it gives up the lease and another session starts
  polling.

On both paths, after a `/clear` or a `/resume` the mod uses the new session
id; a line that arrives during a `/clear` waits, unconfirmed, for the old
session. After an error the mod waits 2 s, then twice as long after each
further error, up to a minute, and shows the error in the status line until a
call succeeds.

## Develop

```bash
pnpm --filter @starbridge/mod test
```

`e2e/run.ts` drives real Claude Code sessions in tmux through each case:
idle, mid-turn, `/clear` and `/resume`, a hot reload, a server outage, two
sessions at once and a default time. It runs against the server app on a
random port (`--local`), or against a real server with a test device
(`e2e/device.ts`) and this machine's CLI config. It needs `claude`, `tmux` and
`starbridge` on `PATH`, and prints one row of timings per case. With
`--agent` it runs `starbridge agent` for the whole run, and a last row checks
that every session answered through it.

The tests run both paths against the CLI, a real agent and the real server,
which `@starbridge/server/test-support` starts on a random port.
`hooks/agent.ts` is the agent path, `hooks/poller.ts` the CLI path,
`hooks/switch.ts` picks one, and `hooks/register.ts` connects them to the
engine. CI type-checks all but `register.ts`. To type-check `register.ts`,
load the mod once so the engine writes its types to `.claude-plugin/types/`,
then run `tsc -p tsconfig.engine.json`.
