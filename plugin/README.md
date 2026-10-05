# Starbridge plugin for Claude Code

The `starbridge` skill teaches agents that Starbridge is how they reach the
owner: a card for each decision that is theirs or each piece of work they must
act on, written so the owner can answer it cold, and `starbridge run` around
any command that blocks them or needs them at the machine. A `SessionStart`
hook adds the matching rule to every session's context. When `rules.md` in
the Starbridge config directory (`~/.config/starbridge`, or
`$XDG_CONFIG_HOME/starbridge`, `$STARBRIDGE_CONFIG_DIR`) has rules for runs,
the hook adds them too, and agents wrap the commands they name as well. Write the
rules in plain words, for example:

```
Tell me when you run the e2e tests that take over my Mac, or local inference.
```

Sessions started afterwards follow them. Uninstalling the plugin removes the
rules from sessions and the skill; `rules.md` stays.

A `PreToolUse` hook on `AskUserQuestion` runs `starbridge hook ask-user`, which
turns the question away and tells the agent to post it with `starbridge ask`.
When the machine is not paired or the server does not answer, it lets the
question through.

It also sends this machine's permission prompts to your devices, once you turn
that on with `starbridge permissions enable`: `PermissionRequest` runs
`starbridge hook permission`, and `PostToolUse`, `PermissionDenied`, `Stop`
and `SessionEnd` run `starbridge hook settle`, which lets the waiting prompt go
when the keyboard answers first. While it is off, both do nothing.

The answers come back through the `starbridge-mod` plugin (`mod/README.md`).
Both need the `starbridge` CLI on `PATH`, paired (`cli/README.md`).

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
