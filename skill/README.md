# skill

`starbridge/` is the Claude Code skill that tells agents when to ask the owner
a decision, how to write one that stands alone on a lock screen, and to keep
working until the answer comes back. The mod (`mod/README.md`) brings the
answer back.

Install it, with the CLI paired and the mod loaded:

```bash
cp -r skill/starbridge ~/.claude/skills/
```

Then add this line to `~/.claude/CLAUDE.md`, so every session uses it:

```
Whenever you need me to decide something, use the `starbridge` skill.
```
