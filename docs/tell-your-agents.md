# Agent instructions

Setup gives every harness the same rules: the agent asks you through Starbridge for decisions
that are yours and for work that waits on you, and wraps the commands that block you in
`starbridge run`. Where Starbridge races the harness's question picker, the rules name it, so a
quick question may use it.

Anything else you want to hear about goes in your harness's instruction files, in your words
([Your own rules](#your-own-rules)). Starbridge never writes to them.

[Terms](index.md#terms) defines harness, agent, question picker and background service.

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
in the interactive CLI 0.160 or later. The prompt holds no answer, since other users on the
machine can read a command's arguments: it tells the agent to run `starbridge wait <id>`, which
returns the answer at once. In `codex exec`, the agent waits with `starbridge wait`.

**Permission prompts.** Starbridge doesn't race them: Codex asks the Starbridge hook before it
opens its own prompt, so each prompt shows in one place. With `starbridge config presence on`, a
prompt stays at the keyboard while you are at this machine and goes to your devices while you
are away. Without presence, a prompt goes to your devices for up to 9.5 minutes, then to the
keyboard.

**Setup.** At its next launch after setup, Codex asks you once to trust the Starbridge plugin's
hooks ("Hooks need review"). Until you do, sessions start without the rules, and `codex exec`
skips them without a word. Codex runs commands in a sandbox with no network, so it asks you once
at the keyboard to run `starbridge run` outside it.

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

**Question picker.** Starbridge doesn't race `askQuestion`, which runs no hooks, and it stays at
the keyboard. The rules tell the agent to use `starbridge ask` instead.

**Answers.** Your answer comes back as the session's next prompt, through the Starbridge stop
hook, in `cursor-agent`. When a chat ends its turn with a question open, the hook holds the chat,
shown as busy, for up to 10 minutes.

Past 10 minutes, and in the Cursor IDE, which doesn't tell a command which chat runs it, the
agent waits with `starbridge wait`. The IDE is untested.

**Permission prompts.** They stay at the keyboard. Cursor shows its own prompt even after a hook
allows the call, so an Allow from your devices could not take effect.

### Antigravity

**Question picker.** Starbridge races `ask_question`. Each question shows at the keyboard and on
your devices at once, and the first answer wins.

**Answers.** Your answer comes back as the session's next prompt, through the conversation's
language server, in interactive conversations. In `agy -p`, the agent waits with `starbridge
wait`.

**Permission prompts.** Starbridge races them. Each prompt shows at the keyboard and on your
devices at once, and the first answer wins. Only a command the agent runs can reach the language
server, so with permission prompts on, the plugin has each new conversation run `starbridge
hello` first.

Checked with `agy`; the Antigravity app and IDE are untested.

## What setup installs

`starbridge setup` installs Starbridge in each harness it finds and prints one line per harness.
`starbridge uninstall --agent <name>` removes it from one, and setup then leaves that harness
alone until `starbridge setup --agent <name>`.

In Claude Code, Codex, Pi, `cursor-agent` and `agy`, setup adds allow rules so that
`starbridge ask`, `waiting`, `working`, `wait` and `settle` run without a permission prompt; in
Pi and `agy`, `hello` too. `starbridge run`
still asks, since the command it wraps can be anything.

- **Claude Code:** the Starbridge plugin, which brings the rules, the skill and the hooks. Beside
  it, the Starbridge mod, which brings your answer back as the session's next prompt. A
  [mod](https://code.claude.com/docs/en/plugins/mods/overview) is code that runs inside Claude
  Code.
- **Codex:** the skill, in `~/.codex/skills/starbridge` (or under `$CODEX_HOME`), and the
  Starbridge Codex plugin, whose hooks bring the rules and send permission prompts. Codex
  installs plugins from a marketplace, so setup writes a local one in `~/.codex/starbridge`. The
  allow rules go in `~/.codex/rules/starbridge.rules` and also let those commands run outside
  the sandbox.
- **Pi:** the Starbridge Pi package (`pi install git:github.com/T0mSIlver/starbridge@v<version>`,
  at your CLI's version), with the skill, the rules and the extension that brings your answer
  back. The allow rules need pi-permission-system: setup adds them, and the Starbridge link in its
  `authorizerChain`, which lets those commands run without a prompt when the command is only
  that. Other reads and commands still ask.
- **opencode:** the skill, in `~/.config/opencode/skills/starbridge`, and the Starbridge plugin,
  in `~/.config/opencode/plugins/starbridge.ts` with its code in `~/.config/opencode/starbridge/`.
  The plugin brings the rules, brings your answer back and sends permission prompts.
- **Cursor:** the skill, in `~/.cursor/skills/starbridge`, and hooks that bring the rules and
  bring your answer back. Their scripts go in `~/.cursor/starbridge`, and their entries in your
  `~/.cursor/hooks.json` beside your own. A chat started after setup has them. The allow rules go
  in `cursor-agent`'s `cli-config.json`: in `$CURSOR_CONFIG_DIR`, else
  `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
- **Antigravity** (the app, the IDE and `agy`): the Starbridge plugin, in
  `~/.gemini/config/plugins/starbridge`, with the rules and the skill. The allow rules go in
  `~/.gemini/antigravity-cli/settings.json` and apply outside `--sandbox`, when the command is
  only that; the plugin's hook makes any other line that runs them ask. In the app and the IDE,
  those commands still ask the first time.

A later setup, or `starbridge update`, updates these files when the CLI carries newer ones
([Update and uninstall](../cli/README.md#update-and-uninstall)).

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
