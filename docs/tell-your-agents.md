# Tell your agents when to use Starbridge

The Starbridge plugin gives every Claude Code session two rules. The agent
reaches you through Starbridge for decisions that are yours and for work that
waits on you. It also wraps commands that take over your machine in
`starbridge run`. Anything else you want to hear about goes in the agent's own
instruction files, in your words. Starbridge never writes to them.

## Where to put the lines

Use your personal files. A repo's `AGENTS.md` or `CLAUDE.md` is committed, so
it applies to everyone who works on that repo.

| Agent | All your repos | One repo, only you |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.local.md` at the repo root. Claude Code loads it alongside the repo's `CLAUDE.md`. |
| Codex | `~/.codex/AGENTS.md` | `AGENTS.override.md` at the repo root. It replaces the repo's `AGENTS.md`, so use it only in a repo without one. |
| pi | `~/.pi/agent/AGENTS.md` | `AGENTS.override.md`, which replaces the repo's `AGENTS.md`, as in Codex. |

Keep a per-repo file out of git by adding its name to `.git/info/exclude`.
Checked on 2026-10-05 with Claude Code 2.1.289, Codex CLI 0.160.0 and pi
0.87.1.

Codex and pi don't load the Claude Code plugin, so each line below names the
command it needs. Codex also reads skills from `~/.codex/skills`: copy
`plugin/skills/starbridge` there so it knows how to write a card. When
`starbridge agent` runs, it queues each answer into the Codex session that
asked, with `codex queue` (Codex CLI 0.160 or later, interactive sessions). In
`codex exec`, in pi, or with no agent running, nothing brings the answer back
after a turn ends; `starbridge ask` says so, and the skill then has the agent
wait with `starbridge wait <id>` before it ends the turn.

## Lines to copy

Paste the lines you want and edit them to fit.

```
Ask me through Starbridge (`starbridge ask`) before you merge a pull request.
Ask me through Starbridge before you deploy.
Ask me through Starbridge before you force-push or delete data.
When CI fails and the fix is not obvious, ask me through Starbridge what to do.
When a long task is done, post a Starbridge card with the next step for me to pick.
Run the e2e tests that take over my Mac through `starbridge run`.
Tell me through `starbridge run` when you run local inference.
```
