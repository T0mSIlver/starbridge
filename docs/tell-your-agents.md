# Agent instructions

The Starbridge plugin gives every Claude Code session two rules. The agent
reaches you through Starbridge for decisions that are yours and for work that
waits on you. It also wraps commands that take over your machine in
`starbridge run`. Anything else you want to hear about goes in the agent's own
instruction files, in your words. Starbridge never writes to them.

## What each agent supports

| | Claude Code | Codex | Pi | opencode |
|---|---|---|---|---|
| Questions | ✓ | ✓ | ✓ | ✓ |
| Answers into the live session | ✓ | ✓¹ | ✓³ | ✓⁵ |
| "Waiting for you" | ✓ | ✓ | ✓ | ✓ |
| Runs | ✓ | ✓⁸ | ✓ | ✓ |
| Permission prompts | Opt-in | Opt-in⁹ | Opt-in⁴ | Opt-in⁶ |
| The agent's own ask tool | ✓² | ✓¹⁰ | n/a | ✓⁷ |

¹ In interactive sessions, when `starbridge agent` runs (Codex CLI 0.160 or
later). In `codex exec`, the agent waits for the answer with `starbridge wait`
before it ends its turn.

² `AskUserQuestion` asks in Claude Code's picker and on your devices at once;
the first answer wins. Pi has no ask tool of its own.

³ In the interactive TUI and RPC mode, through `starbridge agent` or the CLI.
In `pi -p`, the agent waits for the answer with `starbridge wait` before it
ends its turn.

⁴ With [pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system),
which `pi install npm:@gotgenes/pi-permission-system` installs. Then
`starbridge config permissions on` offers to add `starbridge` to its
`authorizerChain`, and to let Starbridge's own calls through without a prompt
(see the Pi item below). Both go in
`~/.pi/agent/extensions/pi-permission-system/config.json`. Your devices can
allow a call once or deny it, and "Answer here" in Pi brings back its own
prompt. An ask from a `path` or `external_directory` rule stays at the
keyboard, because pi-permission-system lets no link allow those. An ask from a
tool rule, such as `read` or `bash`, reaches your devices.

⁵ In the TUI and `opencode serve`, through `starbridge agent` or the CLI. In
`opencode run`, the agent waits for the answer with `starbridge wait` before it
ends its turn.

⁶ Like Claude Code's: opencode's prompt stays open at the keyboard and the
first answer wins. Your devices can allow a call once or deny it. `opencode run`
rejects every prompt at once, so none reaches your devices.

⁷ Each question of opencode's `question` tool reaches your devices too, its
options as one-tap answers, and your answer goes back into the waiting call.
The question stays open in the terminal, and the first answer wins; answering
or dismissing it there closes it on your devices. A question with more than 4
options lists them and takes a typed reply; to pick several where the agent
allows it, reply with their names.

⁸ Codex asks you once at the keyboard to run `starbridge run` outside its
sandbox, which has no network. The skill has Codex ask before the first run,
so the wrapped command runs once, outside.

⁹ Codex asks the Starbridge hook before it opens its own prompt, so the two
can't both be open. With `starbridge config presence on`, a prompt goes to the
terminal while you're at this machine and to your devices while you're away;
when you sit back down, it moves to the terminal. Without presence, or on a
machine with no screen, each prompt waits up to 10 minutes for your devices
before Codex asks in the terminal. Your devices can allow a call once or deny
it. Codex asks you once, at its next launch, to trust the plugin's hooks.

¹⁰ Codex's own question tool, which it uses in Plan mode, asks in the terminal
and on your devices at once; the first answer wins. A typed reply reaches
Codex as a note, as one typed in the terminal does.

`starbridge setup` installs Starbridge in each agent it finds, and prints one
line per agent; `starbridge uninstall --agent <name>` removes it from one, and
setup then leaves that agent alone until `starbridge setup --agent <name>`:

- Claude Code: the Starbridge plugin, which brings the rules above, the skill
  and the hooks, and allow rules so that `starbridge ask`, `waiting`,
  `working`, `wait` and `settle` run without a permission prompt. Beside it,
  the Starbridge mod, a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (code that runs
  inside Claude Code, 2.1.287 or later), submits each answer into the live
  session as its next prompt, in the terminal, the desktop app and Remote
  Control.
- Codex: the skill, in `~/.codex/skills/starbridge` (or under `$CODEX_HOME`),
  so it knows how to write a question, and the Starbridge Codex plugin, whose
  hooks bring the rules above and send permission prompts once you turn them on. Codex installs plugins from a
  marketplace, so setup writes a local one in `~/.codex/starbridge` and installs
  the plugin from it. Codex asks once, at its next launch, to trust the hooks
  ("Hooks need review"); until you trust them, sessions start without the rules,
  and `codex exec` skips them without a word. A later setup updates
  the skill and the rules when the CLI carries newer ones. Codex runs commands in a sandbox with no network, so setup also writes
  `~/.codex/rules/starbridge.rules`, which runs `starbridge ask`, `waiting`,
  `working`, `wait` and `settle` outside it.
- Pi: the Starbridge Pi package (`pi install
  git:github.com/T0mSIlver/starbridge@v<version>`, at your CLI's version), which brings the skill, the rules and
  the extension that puts each answer into the session. With
  pi-permission-system, setup adds, and `starbridge config permissions on` offers,
  allow rules, so that Pi loads the `starbridge` skill and reads the files in its
  folder without a prompt, and the Starbridge link in its `authorizerChain`, which
  runs `starbridge ask`, `waiting`, `working`, `wait` and `settle` without one
  when the command is only that. Other reads and commands still ask.
- opencode: the skill, in `~/.config/opencode/skills/starbridge`, and the
  Starbridge plugin, in `~/.config/opencode/plugins/starbridge.ts` with its code
  in `~/.config/opencode/starbridge/`. The plugin brings the rules, puts each
  answer into the session and sends permission prompts. A later setup, or the
  agent once `starbridge update` restarts it, updates both when the CLI carries
  newer ones.

## Where the lines go

Put your lines in a file only you use. A repo's `AGENTS.md` or `CLAUDE.md` is
committed, so lines there apply to everyone who works on the repo.

<dl>
<dt>Claude Code</dt>
<dd>Every repo: <code>~/.claude/CLAUDE.md</code>. One repo: <code>CLAUDE.local.md</code>.</dd>
<dt>Codex</dt>
<dd>Every repo: <code>~/.codex/AGENTS.md</code>. One repo: <code>AGENTS.override.md</code>.</dd>
<dt>Pi</dt>
<dd>Every repo: <code>~/.pi/agent/AGENTS.md</code>. One repo: <code>AGENTS.override.md</code>.</dd>
<dt>opencode</dt>
<dd>Every repo: <code>~/.config/opencode/AGENTS.md</code>. One repo: a file you name in <code>instructions</code> in <code>.opencode/opencode.json</code>, such as <code>["AGENTS.local.md"]</code>.</dd>
</dl>

The one-repo files go at the repo root. Add the file's name to
`.git/info/exclude` to keep it out of git, and for opencode `.opencode/opencode.json`
too.

Claude Code reads `CLAUDE.local.md` in addition to the repo's `CLAUDE.md`.
`AGENTS.override.md` replaces the repo's `AGENTS.md` instead, so in a repo that
has an `AGENTS.md`, put your lines in the every-repo file.

Checked on 2026-10-05 with Claude Code 2.1.289, Codex CLI 0.160.0 and Pi
0.87.1, and on 2026-10-06 with opencode 1.18.31.

## Rules for Codex

Setup used to have you paste the rules into `~/.codex/AGENTS.md`, since Codex had no plugins.
The Starbridge Codex plugin now brings them: once `starbridge status` says `Codex plugin:
installed` and you have trusted its hook, remove the pasted rules, or Codex reads them twice.

## Lines to copy

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
