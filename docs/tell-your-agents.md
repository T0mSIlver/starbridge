# Tell your agents when to use Starbridge

The Starbridge plugin gives every Claude Code session two rules. The agent
reaches you through Starbridge for decisions that are yours and for work that
waits on you. It also wraps commands that take over your machine in
`starbridge run`. Anything else you want to hear about goes in the agent's own
instruction files, in your words. Starbridge never writes to them.

## What each agent supports

| | Claude Code | Codex | Pi |
|---|---|---|---|
| Questions | ✓ | ✓ | ✓ |
| Answers into the live session | ✓ | ✓¹ | ✓³ |
| "Waiting for you" | ✓ | ✓ | ✓ |
| Runs | ✓ | ✓ | ✓ |
| Permission prompts | Opt-in | No | Opt-in⁴ |
| `AskUserQuestion` hook | ✓ | n/a² | n/a² |

¹ In interactive sessions, when `starbridge agent` runs (Codex CLI 0.160 or
later). In `codex exec`, the agent waits for the answer with `starbridge wait`
before it ends its turn.

² Codex and Pi have no `AskUserQuestion` tool. The hook turns Claude Code's
questions in the terminal into Starbridge questions.

³ In the interactive TUI and RPC mode, through `starbridge agent` or the CLI.
In `pi -p`, the agent waits for the answer with `starbridge wait` before it
ends its turn.

⁴ With [pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system):
`starbridge config permissions on` offers to add `starbridge` to its
`authorizerChain` (in `~/.pi/agent/extensions/pi-permission-system/config.json`). Your devices can allow a call once or deny
it; "Answer here" in Pi brings back its own prompt. Reading or writing a path that a `path` or
`external_directory` rule guards stays at the keyboard: pi-permission-system lets no link allow
those.

`starbridge setup` offers to install Starbridge in each agent it finds, and
asks before each one:

- Claude Code: the Starbridge plugin, which brings the rules above, the skill
  and the hooks, and allow rules so that `starbridge ask`, `waiting`, `wait`
  and `settle` run without a permission prompt.
- Codex: the skill, in `~/.codex/skills/starbridge` (or under `$CODEX_HOME`),
  so it knows how to write a question. Codex doesn't load plugins, so it runs
  the same `starbridge` commands without the rules: add the lines you want
  below. A later setup offers to update the skill when the CLI carries a newer
  one. Codex runs commands in a sandbox with no network, so setup also writes
  `~/.codex/rules/starbridge.rules`, which runs `starbridge ask`, `waiting`,
  `wait` and `settle` outside it.
- Pi: the Starbridge Pi package (`pi install
  git:github.com/T0mSIlver/starbridge`), which brings the skill, the rules and
  the extension that puts each answer into the session.

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
</dl>

The one-repo files go at the repo root. Add the file's name to
`.git/info/exclude` to keep it out of git.

Claude Code reads `CLAUDE.local.md` in addition to the repo's `CLAUDE.md`.
`AGENTS.override.md` replaces the repo's `AGENTS.md` instead, so in a repo that
has an `AGENTS.md`, put your lines in the every-repo file.

Checked on 2026-10-05 with Claude Code 2.1.289, Codex CLI 0.160.0 and Pi
0.87.1.

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
