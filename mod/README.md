# Starbridge mod for Claude Code

When the owner answers a decision, this mod submits the answer into the Claude
Code session that asked, as the line `starbridge wait` prints:

```
Answer to d_amber-otter-… (Merge #12 now?): Merge
```

It works in the terminal, the desktop app's Code tab, IDEs and Remote Control.

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

The mod skips `claude -p`, whose run ends with its last turn, told apart by
`CLAUDE_CODE_ENTRYPOINT` (`sdk-cli`). An Agent SDK session (`sdk-ts`,
`sdk-py`) gets its loop once its first turn ends, since only an app that keeps
the session open runs a second one.

The mod holds no keys. Each session picks one of two paths, and
switches when the agent starts or stops.

### Through the agent

When the machine's agent (`starbridge agent`, PROTOCOL.md, "Local agent API")
answers on its unix socket, each session talks to it with `$.http.fetch`:

- `POST /v1/sessions/<id>/hello` once per session id, with the session's
  working directory.
- `GET /v1/sessions/<id>/events?wait=25` back to back, under the 30 s limit on
  calls from a mod. The agent hands the session only the answers to the
  decisions it asked.
- The mod submits each event's line, then confirms it with
  `POST /v1/sessions/<id>/ack`; the agent hands an unconfirmed event over
  again. It skips event types it does not know.
- `POST /v1/sessions/<id>/bye` when the session ends.

The socket is `$STARBRIDGE_AGENT_SOCKET`, else
`$XDG_RUNTIME_DIR/starbridge/agent-<key>.sock` for the default config directory,
where `<key>` comes from the config directory's path, else `agent.sock` in the
config directory, as the CLI works it out; on Windows (`OS=Windows_NT`), the
port file `agent.port` in the config directory, which names the loopback port
and the token every call carries (PROTOCOL.md). A 426 (the agent speaks another
API revision), a 421 (the agent serves another config directory) or a call that
cannot connect sends the session to the CLI path.

### Through the CLI

With no agent, or with `STARBRIDGE_NO_AGENT=1`, the mod runs the CLI and checks
for the agent every 30 s.

- Every session runs the mod, but only one per machine polls: the
  session holding the lease in `~/.config/starbridge/mod-poller.json`. It runs
  `starbridge answers --session <id> --wait 25` back to back, which stays
  under the 30 s limit on calls from a mod.
- The other sessions watch `state.json`. When it changes, they run `starbridge
  answers --session <id>`, which reads local state only.
- `answers` returns only answers to decisions that session asked and that no
  `wait` has printed. The mod submits each line, then confirms it with
  `starbridge answers --session <id> --ack <ack>`; the CLI hands an
  unconfirmed line over again.
- A session that does not poll also runs `answers` every 30 s when
  `state.json` has not changed, in case a change went unseen.
- When a session ends, it gives up the lease and another session starts
  polling.

On both paths, after a `/clear` or a `/resume` the mod uses the new session
id; a line that arrives during a `/clear` waits, unconfirmed, for the old
session. After an error the mod waits 2 s, then twice as long after each
further error, up to a minute, and shows the error in the status line until a
call succeeds.

Claude Code runs a submitted prompt only once the running turn ends. So while
the agent works, an answer goes with its next tool result, which it reads at
once; one that comes after the turn's last tool call is submitted when the
turn ends. The answers one poll brings go as one prompt, a line each (#1597).

A subagent's answer goes to that subagent with `$.session.send`, during the
main agent's turn or not (#1702). For a subagent's Bash command that runs
`starbridge ask`, the mod exports `STARBRIDGE_CLAUDE_AGENT=<its agent id>`
first, which the CLI keeps with the decision; the permission check judges the
command without it. A subagent that is running reads the answer at its next tool
call, and a finished one is resumed with it. When the send fails, the answer
goes to the parent as a prompt that names the subagent. An answer sent to a
running subagent stays in `mod-sent` until a tool round of the subagent ends
after the send, so a later process on the session hands an unread one to the
parent. A subagent that finishes without another tool round never reads it: the
parent gets it then (#1729).

An answer submitted as a prompt stays in
`~/.config/starbridge/mod-sent/<session>.json` until its turn starts. Claude
Code loses a queued prompt when its process exits, so a later process on that
session, such as `claude --resume`, submits it again, once.

## Pi

`pi/starbridge.ts` is the same answer loop as a Pi extension. It ships in the
repository's Pi package with the `starbridge` skill. `starbridge setup` installs it at the
commit of the CLI's release. By hand, at a release tag, `v` and what `starbridge --version` prints:

```bash
pi install git:github.com/T0mSIlver/starbridge@v<version>
```

In an interactive or RPC Pi session it submits each answer as a user message,
which starts a turn when Pi is idle. When Pi is busy, the answer enters the
running turn at its next tool call (`deliverAs: "steer"`). It also adds its rule (`plugin/rules/pi.md`) to Pi's system
prompt. `pi -p` gets no loop, so `starbridge ask` tells the agent there to
`starbridge wait`.

With [pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
installed, `pi/permissions.ts` registers a `starbridge` link in its authorizer
chain, which the owner turns on with `"authorizerChain": ["starbridge"]` in its
`config.json` (`starbridge setup` adds it, and so does `starbridge config permissions on`). When a rule says `ask`, the link runs `starbridge hook permission
--agent pi`, as Claude Code's hook does, and returns the devices' allow (this
call only: the chain never lets a link allow for the session) or deny with
their message. Meanwhile Pi shows "Answer here", which takes the prompt back
from the devices and opens pi-permission-system's own dialog. The link defers
to that dialog at once while `starbridge config permissions` is off, the
machine is not paired or the server does not answer, and after 570 s.

With rpiv-ask-user-question installed, each of its questionnaires
(`rpiv:ask-user:prompt`) runs `starbridge hook question --agent pi`, as
opencode's questions do (below). The `ask_user_question` tool returning stops
the CLI, which settles the questions still open. From the package's 2.13.9, a
device's answers go in on `rpiv:ask-user:answer`, keyed by the questionnaire's
`toolCallId`, and the package's verdict on `rpiv:ask-user:answer-result` says
whether they took (#1516). With an older release, the extension wraps Pi's
shared `ctx.ui.custom` to keep the `done` of the dialog the package opens right
after `rpiv:ask-user:blocked`, so a device's answers close it as a keyboard
submit does. In Pi's RPC mode, or when the package refuses the answer, they come
as a follow-up message once the questionnaire closes.

## opencode

`opencode/starbridge.ts` is the same answer loop as an opencode plugin.
`starbridge setup` copies it, with the files it imports from `hooks/` and the
rule, into `~/.config/opencode/starbridge/`, and points
`~/.config/opencode/plugins/starbridge.ts` at it.

opencode gives commands no session id, so the plugin's `shell.env` hook sets
`STARBRIDGE_OPENCODE_SESSION` and the session's title for them, and starts that
session's loop. Each answer goes in with `promptAsync`: an idle session starts
a turn, a busy one takes it at its next step. `opencode run` gets no loop, so
`starbridge ask` tells the agent there to `starbridge wait`. The rule goes into
the system prompt through `experimental.chat.system.transform`.

Each `permission.asked` event runs `starbridge hook permission --agent
opencode`, which exits at once while `starbridge config permissions` is off.
opencode's dialog stays up meanwhile: the devices' answer is sent through
opencode's reply route, and an answer at the keyboard stops the CLI, which
settles the prompt on the devices.
The devices see what an Allow approves: the command for `bash`; the paths and
the diff for `edit`, which its edit, write and apply_patch tools ask, with
where a move takes a file and which files a patch deletes; the directories
and the command for an `external_directory` ask from its shell. Other
permissions show their patterns and metadata. An MCP tool call shows only the
tool's name, since opencode's permission event carries none of its arguments.
Past 8,000 characters the CLI cuts the longest string and says so.

Each `question.asked` event (a call of opencode's `question` tool) runs
`starbridge hook question --agent opencode`, which posts each question with its
labels as options and prints the answers once all are in. The plugin sends them
through `POST /question/{id}/reply`. An answer or Esc at the keyboard
(`question.replied` or `question.rejected`) stops the CLI, which settles the
questions on the devices.

## Develop

```bash
pnpm --filter @starbridge/mod test
```

`e2e/run.ts` drives real Claude Code sessions in tmux through each case:
idle, mid-turn, `/clear` and `/resume`, a hot reload, a server outage, two
sessions at once, and a background subagent that asks, answered while it runs
and after it finished. It runs against the server app on a
random port (`--local`), or against a real server with a test device
(`e2e/device.ts`) and this machine's CLI config. It needs `claude`, `tmux` and
`starbridge` on `PATH`, and prints one row of timings per case. With
`--agent` it runs `starbridge agent` for the whole run, and a last row checks
that every session answered through it. `STARBRIDGE_E2E_CLAUDE_ENV` names a
file of `KEY=value` lines the sessions read, such as a `CLAUDE_CODE_OAUTH_TOKEN`
from `claude setup-token`, so the login stays out of every command line.

The tests run both paths against the CLI, a real agent and the real server,
which `@starbridge/server/test-support` starts on a random port.
`hooks/agent.ts` is the agent path, `hooks/poller.ts` the CLI path,
`hooks/switch.ts` picks one, and `hooks/register.ts` connects them to the
engine. CI type-checks all but `register.ts`. To type-check `register.ts`,
load the mod once so the engine writes its types to `.claude-plugin/types/`,
then run `tsc -p tsconfig.engine.json`.
