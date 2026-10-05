# Starbridge plugin for Claude Code

The `starbridge` skill tells agents when to ask the owner a decision, how to
write one that stands alone on a lock screen, and to keep working until the
answer comes back, and to wrap in `starbridge run` any command that blocks
the owner or needs them at the machine, so their phone shows it running.
A `SessionStart` hook adds two rules to every session's context:
"Whenever you need me to decide something, use the `starbridge` skill.",
and to wrap such commands. When `rules.md` in the Starbridge config
directory (`~/.config/starbridge`, or `$XDG_CONFIG_HOME/starbridge`,
`$STARBRIDGE_CONFIG_DIR`) has rules for runs, the hook adds them too, and
agents wrap the commands they name as well. Write the
rules in plain words, for example:

```
Tell me when you run the e2e tests that take over my Mac, or local inference.
```

Sessions started afterwards follow them. Uninstalling the plugin removes the
rules from sessions and the skill; `rules.md` stays.

It also sends this machine's permission prompts to your devices, once you turn
that on with `starbridge config permissions on` (off by default): `PermissionRequest` runs
`starbridge hook permission`, and `PostToolUse`, `PermissionDenied`, `Stop`
and `SessionEnd` run `starbridge hook settle`, which lets the waiting prompt go
when the keyboard answers first. While it is off, both exit at once.

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
