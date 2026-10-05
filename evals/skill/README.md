# Skill eval

Checks that agents reach their user through Starbridge the way the `starbridge` skill and the
SessionStart rule say (issue #121). Real Claude Code and Codex sessions work through nine
scripted situations (`scenarios.ts`), once with the plugin at a git ref and once with this
checkout's, and a rubric scores the cards they post.

```bash
bun evals/skill/run.ts --agent claude --reps 2          # records in results/claude
bun evals/skill/run.ts --agent codex --reps 2           # records in results/codex
bun evals/skill/grade.ts evals/skill/results/claude evals/skill/results/codex
bun evals/skill/render.ts --out evals/skill/cards evals/skill/results/claude/after-merge-order-1.json
```

`run.ts` gives every run a throwaway home, a throwaway `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
holding a copy of the login, the real server app on a random port with the CLI paired to it, a
git project with a bare remote, and a `gh` that prints canned output. Nothing touches your own
`~/.claude` or `~/.codex`. Claude Code loads the plugin with `--plugin-dir`; Codex gets the
skill in `$CODEX_HOME/skills` and the rule in `$CODEX_HOME/AGENTS.md`. Situations with a
follow-up answer the card with its recommended option, in the line the mod submits, and check
that the agent acts on it.

`grade.ts` scores each run: eleven checks read the record, five ask GLM 5.3 through `opencode`
(stored in the record, so grading again is free). `render.ts` shows cards in the real web
inbox (headless Chromium) and saves a screenshot of each.
