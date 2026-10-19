# Starbridge plugin for Claude Code

The `starbridge` skill teaches agents that Starbridge is how they reach the
owner: a card for each decision that is theirs or each piece of work they must
act on, written so the owner can answer it cold, and `starbridge run` around
any command that blocks them or needs them at the machine. A `SessionStart`
hook adds the matching rule to every session's context. To tell agents more,
such as which commands to report or which merges to ask about, put lines in
their own instruction files: [Agent instructions](https://starbridge.run/docs/tell-your-agents)
says where.

When Claude Code opens its `AskUserQuestion` picker, a `PermissionRequest` hook
posts the question to your devices too: each question shows at the keyboard and
on your devices at once, and the first answer wins.

It also sends this machine's permission prompts to your devices, once you turn
that on (off by default; setup asks, and `starbridge config permissions on` turns it on later): `PermissionRequest` runs
`starbridge hook permission`, and `PostToolUse`, `PostToolUseFailure`,
`PermissionDenied`, `Stop` and `SessionEnd` run `starbridge hook settle`, which lets the waiting prompt go
when the keyboard answers first. While it is off, both exit at once.

The answers come back through the `starbridge-mod` plugin (`mod/README.md`).
Both need the `starbridge` CLI on `PATH`, paired ([The CLI](https://starbridge.run/docs/cli)).

## Install

```bash
claude plugin marketplace add T0mSIlver/starbridge
claude plugin install starbridge@starbridge --scope user
claude plugin install starbridge-mod@starbridge --scope user
```

Sessions started afterwards load both. If you installed the skill or the mod
by hand before, remove the copies (`~/.claude/skills/starbridge`, the mod's
folder in `CLAUDE_CODE_PLUGIN_DIRS`, and the rule in `~/.claude/CLAUDE.md`),
so nothing loads twice.
