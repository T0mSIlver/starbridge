# Starbridge plugin for Claude Code

The `starbridge` skill tells agents when to ask the owner a decision, how to
write one that stands alone on a lock screen, and to keep working until the
answer comes back. A `SessionStart` hook adds one rule to every session's
context: "Whenever you need me to decide something, use the `starbridge`
skill." Uninstalling the plugin removes both.

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
