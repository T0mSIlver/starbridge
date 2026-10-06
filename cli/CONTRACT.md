# What agents parse

Agents, the Starbridge skill, the Claude Code plugins, the Pi extension and the opencode
plugin read the commands below and their output. The plugins update apart from the CLI, so this list is
stable from 0.1.0, the first public release: a release may add commands, flags, variables, fields
and lines, but changes or removes anything here only after a release that deprecates it. `cli/test/contract.test.ts` pins
the lines; the hook outputs are pinned in `cli/test/permissions.test.ts`.

| Command | Contract |
|---|---|
| `ask` | Flags `--question`, `--context`, `--context-file`, `--option`, `--recommended`, `--waiting`, `--agent`, `--project`, `--session`, `--session-title`, `--session-link`, `--image`, `--link`, `--answer-in`, `--input <path>` (a JSON file with the same fields, `-` for stdin), `--wait`, `--timeout`. Prints the decision id alone on stdout: `d_` and 16 characters from `A-Z a-z 0-9 _ -`. With `--wait`, then what `wait` prints; without it, one line on stderr, either `The answer will come back into this session as a new prompt.` or ``Nothing brings the answer into this session: when only the answer is left, run `starbridge wait <id> --timeout 5m` (again on exit 2).`` |
| `wait [<id>]` | Flags `--timeout`, `--json`. Prints `Answer to <id> (<question>): <choice or text>`, or for an `--answer-in` question the owner marked Done, `Answer to <id> (<question>): answered on its page; read the answer there`; with `--json`, the answer as one JSON object with `decisionId` and `choice`, `text` or `done: true`. Exits 2 when `--timeout` passed. With an id, when the owner snoozed the question, prints `Snoozed <id> (<question>) until <time>: no answer before then.` once per snooze and exits 3; with `--json`, `{"decisionId", "snoozedUntil"}`. An agent restart does not end it: it asks the new agent, and after 30 s with none it waits at the server. |
| `waiting <id>`, `working <id>` | No output on success, but `waiting` prints the `Snoozed` line above while the owner has snoozed the question. |
| `settle <id>` | Flag `--outcome elsewhere\|withdrawn`. |
| `answers --session <id>` | Flags `--wait <seconds>`, `--ack <ack>`. Prints one JSON object per line: `{"decisionId", "ack", "line"}`, where `line` is the `Answer to` line above. |
| `answers --all` | Flags `--follow`, `--since <time or duration>` (a duration takes its unit: `90s`, `2h`). Prints one JSON object per line, oldest first: `{"decisionId", "question", "choice" or "text" or "done": true, "answeredAt", "session"?, "sessionTitle"?, "project"?}`. With `--follow`, then each new answer until interrupted. Marks nothing seen or waiting. |
| `decisions --open` | Prints one JSON object per line, oldest first: `{"decisionId", "question", "options", "askedAt", "waiting", "session"?, "sessionTitle"?, "project"?}`. |
| `run` | Flags `--title`, `--reason`, then `--` and the command. Exits with the command's code: 127 when it cannot start, 128 plus the signal when a signal ends it. |
| `hook permission` | Flags `--agent claude-code\|pi\|opencode`, `--wait`. Reads the hook's JSON on stdin and prints the output its harness defines, or nothing to leave the prompt to the keyboard. SIGTERM means the keyboard answered. Exits 0. |
| `hook settle` | Flag `--agent claude-code`. Reads the hook's JSON on stdin. Exits 0. |
| `hook ask-user` | Reads the hook's JSON on stdin; prints a PreToolUse output that answers each question with an instruction to use `starbridge ask` (a denial when it cannot read the input), or nothing to let the question through. Exits 0. |
| `pair` | Prints `Pairing code: <code>` first. |

Codex sessions receive ``Starbridge has the owner's answer to <id>: run `starbridge wait <id>` to read it.``
as a queued prompt. The plugins set `STARBRIDGE_PI_ANSWERS`, `STARBRIDGE_OPENCODE_SESSION`,
`STARBRIDGE_OPENCODE_TITLE` and `STARBRIDGE_OPENCODE_ANSWERS` for the commands their agents run,
and read `STARBRIDGE_CONFIG_DIR`, `STARBRIDGE_AGENT_SOCKET` and `STARBRIDGE_NO_AGENT`.

The hooks exit 1 only when stdin cannot be read. Every other command exits 0 on success and 1 on an error, with the error on stderr after
`starbridge: `. Ctrl-C exits 130.
