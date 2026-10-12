# Agent instructions

Setup gives every harness the same rules: the agent asks you through Starbridge for decisions
that are yours, and wraps the commands that block you in `starbridge run`. Anything else goes in
[your own rules](#your-own-rules), which Starbridge never writes to.
[Terms](index.md#terms) defines harness, agent and question picker.

<a id="what-each-agent-supports"></a>

## What each harness supports

| | Claude Code | Codex | Pi | opencode | Cursor | Antigravity |
|---|---|---|---|---|---|---|
| Question picker raced on your devices | ✓ | ✓ | With add-on | ✓ | No | ✓ |
| Answer comes back without polling¹ | ✓ | ✓ | ✓ | ✓ | CLI only | ✓ |
| Permission prompts on your devices² | Opt-in | Opt-in | Opt-in | Opt-in | No | Opt-in |
| Runs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| "Waiting for you" | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

A raced question picker shows each question at the keyboard and on your devices at once, and the
first answer wins.

¹ Your answer to a `starbridge ask` question comes back as the session's next prompt, so the
agent doesn't wait for it with `starbridge wait`. A headless run (`claude -p`, `codex exec`,
`pi -p`, `opencode run`, `cursor-agent -p`, `agy -p`) has no next prompt, so there the agent
waits with `starbridge wait` before it ends its turn.

² Off until you run `starbridge config permissions on` on the machine. Your devices can then
allow a call once or deny it.

### Claude Code

**Question picker.** Starbridge races `AskUserQuestion`. Each question shows at the keyboard and
on your devices at once, and the first answer wins.

**Answers.** Your answer comes back as the session's next prompt, through the Starbridge mod, in
Claude Code 2.1.287 or later. This works in the terminal, the desktop app, IDEs and Remote
Control. In `claude -p` and Agent SDK scripts, the agent waits with `starbridge wait`.

**Permission prompts.** Starbridge races them. Each prompt shows at the keyboard and on your
devices at once, and the first answer wins. Your devices also offer "this session" or "always"
when Claude Code does.

Only prompts Claude Code still shows reach your devices: in auto mode, its default, it settles
most calls itself.

### Codex

**Question picker.** Starbridge races `request_user_input`. Each question shows at the keyboard
and on your devices at once, and the first answer wins. Codex offers this picker only in Plan
mode. On Windows, Starbridge doesn't race it, and it stays at the keyboard.

**Answers.** Your answer comes back as the session's next prompt, through Codex's message queue,
in the interactive CLI 0.160 or later. In `codex exec`, the agent waits with `starbridge wait`.

**Permission prompts.** Starbridge doesn't race them: each prompt shows in one place. With `starbridge config presence on`, a
prompt stays at the keyboard while you are at this machine and goes to your devices while you
are away. Without presence, a prompt goes to your devices for up to 9.5 minutes, then to the
keyboard.

**Setup.** At its next launch after setup, Codex asks you once to trust the Starbridge plugin's
hooks ("Hooks need review"). Until you do, sessions start without the rules. Codex also asks you
once to run `starbridge run` outside its sandbox, which has no network.

If you pasted Starbridge's rules into `~/.codex/AGENTS.md` before the plugin existed, remove them
once `starbridge status` says `Codex plugin: installed`, or Codex reads them twice.

### Pi

**Question picker.** Pi has none of its own. If you add `ask_user_question` from
@juicesharp/rpiv-ask-user-question, Starbridge races it in the TUI. Each question shows at the
keyboard and on your devices at once, and the first answer wins. In RPC mode, an answer from your
devices reaches the agent only once the question closes at the keyboard.

**Answers.** Your answer comes back as the session's next prompt, through the Starbridge Pi
package, in the TUI and RPC mode. In `pi -p`, the agent waits with `starbridge wait`.

**Permission prompts.** They need
[pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
(`pi install npm:@gotgenes/pi-permission-system`). Starbridge doesn't race them: each prompt goes
to your devices, and "Answer here" in Pi brings it back to the keyboard. Prompts from its `path`
and `external_directory` rules stay at the keyboard.

### opencode

**Question picker.** Starbridge races `question`. Each question shows at the keyboard and on your
devices at once, and the first answer wins. A question with more than 4 options takes a typed
reply on your devices.

**Answers.** Your answer comes back as the session's next prompt, through the Starbridge opencode
plugin, in the TUI and `opencode serve`. In `opencode run`, the agent waits with `starbridge wait`.

**Permission prompts.** Starbridge races them. Each prompt shows at the keyboard and on your
devices at once, and the first answer wins. `opencode run` rejects every prompt itself, so none
reaches your devices.

### Cursor

**Question picker.** Starbridge doesn't race `askQuestion`, and it stays at the keyboard. The
rules tell the agent to use `starbridge ask` instead.

**Answers.** Your answer comes back as the session's next prompt, through the Starbridge stop
hook, in `cursor-agent`. When a chat ends its turn with a question open, the hook holds the chat,
shown as busy, for up to 10 minutes.

Past 10 minutes, and in the Cursor IDE, the agent waits with `starbridge wait`. The IDE is
untested.

**Permission prompts.** They stay at the keyboard.

### Antigravity

**Question picker.** Starbridge races `ask_question`. Each question shows at the keyboard and on
your devices at once, and the first answer wins.

**Answers.** Your answer comes back as the session's next prompt, through the conversation's
language server, in interactive conversations. In `agy -p`, the agent waits with `starbridge
wait`.

**Permission prompts.** Starbridge races them. Each prompt shows at the keyboard and on your
devices at once, and the first answer wins. With permission prompts on, each new conversation
first runs `starbridge hello`.

Checked with `agy`; the Antigravity app and IDE are untested.

## What setup installs

Setup prints one line per harness it installs in. `starbridge uninstall --agent <name>` removes
Starbridge from one, until `starbridge setup --agent <name>`. A later setup, or
`starbridge update`, brings these files to the CLI's version.

| Harness | What | Where |
|---|---|---|
| Claude Code | The Starbridge plugin (rules, skill, hooks) and the Starbridge [mod](https://code.claude.com/docs/en/plugins/mods/overview), code that runs inside Claude Code and brings your answer back | Claude Code's plugins, at user scope |
| Codex | The skill, and the Starbridge Codex plugin (rules, permission prompts) from a local marketplace | `~/.codex/skills/starbridge` (or under `$CODEX_HOME`), `~/.codex/starbridge` |
| Pi | The Starbridge Pi package (skill, rules, the extension that brings your answer back) | `pi install git:github.com/T0mSIlver/starbridge@v<version>` |
| opencode | The skill, and the Starbridge plugin (rules, answers, permission prompts) | `~/.config/opencode/skills/starbridge`, `~/.config/opencode/plugins/starbridge.ts`, `~/.config/opencode/starbridge/` |
| Cursor | The skill, and hooks that bring the rules and your answer back, beside your own | `~/.cursor/skills/starbridge`, `~/.cursor/starbridge`, `~/.cursor/hooks.json` |
| Antigravity | The Starbridge plugin (rules, skill), loaded by the app, the IDE and `agy` | `~/.gemini/config/plugins/starbridge` |

Setup also adds allow rules so that `starbridge ask`, `waiting`, `working`, `wait` and `settle`
run without a permission prompt; in Pi and `agy`, `hello` too. They go in:

- Claude Code: the plugin.
- Codex: `~/.codex/rules/starbridge.rules`, which also runs them outside the sandbox.
- Pi: pi-permission-system's rules and its `authorizerChain`, only when it is installed.
- `cursor-agent`: its `cli-config.json`, in `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`,
  else `~/.cursor`.
- `agy`: `~/.gemini/antigravity-cli/settings.json`, outside `--sandbox`. The Antigravity app and
  IDE still ask the first time.

In Pi and `agy`, they apply only when the command is that alone. `starbridge run` still asks,
since the command it wraps can be anything.

## Your own rules

<a id="where-the-lines-go"></a>

Put your lines in a file only you use. A repo's `AGENTS.md` or `CLAUDE.md` is committed, so lines
there apply to everyone who works on the repo.

| Harness | Every repo | One repo |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.local.md` |
| Codex | `~/.codex/AGENTS.md` | `AGENTS.override.md` |
| Pi | `~/.pi/agent/AGENTS.md` | `AGENTS.override.md` |
| opencode | `~/.config/opencode/AGENTS.md` | a file you name in `instructions` in `.opencode/opencode.json`, such as `["AGENTS.local.md"]` |
| Antigravity | `~/.gemini/GEMINI.md` | a file in `.agents/rules/`, such as `.agents/rules/local.md` |

The one-repo files go at the repo root, except Antigravity's. Add each file you create to
`.git/info/exclude` to keep it out of git, `.opencode/opencode.json` included.

Claude Code reads `CLAUDE.local.md` in addition to the repo's `CLAUDE.md`. `AGENTS.override.md`
replaces the repo's `AGENTS.md` instead, so in a repo that has an `AGENTS.md`, put your lines in
the every-repo file.

Checked on 2026-10-05 with Claude Code 2.1.289, Codex CLI 0.160.0 and Pi 0.87.1, and on
2026-10-06 with opencode 1.18.31.

### Lines to copy

Paste the lines you want and edit them to fit.

```
Ask me through Starbridge before you deploy.
Ask me through Starbridge (`starbridge ask`) before you merge a pull request.
Ask me through Starbridge before you force-push or delete data.
When CI fails and the fix is not obvious, ask me through Starbridge what to do.
When a long task is done, ask me through Starbridge which next step to take.
Run the e2e tests that take over my Mac through `starbridge run`.
Tell me through `starbridge run` when you run local inference.
```
