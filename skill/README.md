# skill

`starbridge/` is the Claude Code skill that tells agents when to ask the owner
a decision and how to write one that stands alone on a lock screen.

Install it, with the CLI paired:

```bash
cp -r skill/starbridge ~/.claude/skills/
```

Then add this line to `~/.claude/CLAUDE.md`, so every session uses it:

```
Whenever you need me to decide something, use the `starbridge` skill.
```
