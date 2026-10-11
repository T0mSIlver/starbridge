# Skill eval

Checks that agents reach their user through Starbridge the way the `starbridge` skill and the
SessionStart rule say. Real Claude Code, Codex, Pi, opencode, Cursor and Antigravity sessions work through the
scripted situations (`scenarios.ts`), once with the plugin at a git ref and once with this
checkout's, and a rubric scores the cards they post.

```bash
TMPDIR=/var/tmp bun evals/skill/run.ts --agent claude --reps 2   # claude-haiku-5-5
TMPDIR=/var/tmp bun evals/skill/run.ts --agent codex --reps 2    # Codex's default model
TMPDIR=/var/tmp bun evals/skill/run.ts --agent pi --reps 2       # zai/glm-5.3-flash
TMPDIR=/var/tmp bun evals/skill/run.ts --agent opencode --reps 2 # zai-coding-plan/glm-5.3-flash
TMPDIR=/var/tmp bun evals/skill/run.ts --agent cursor --reps 2   # auto
TMPDIR=/var/tmp bun evals/skill/run.ts --agent antigravity --reps 2 # gemini-3.8-flash-medium
bun evals/skill/grade.ts evals/skill/results/claude evals/skill/results/codex
bun evals/skill/tokens.ts                                        # tokens each injected piece costs
bun evals/skill/render.ts --out evals/skill/cards evals/skill/results/claude/after-merge-order-1.json
```

`run.ts` gives every run a throwaway home, a throwaway `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR` or opencode XDG folders holding the login, the real server app on a random port with the
CLI paired to it, a git project with a bare remote, and a `gh` that prints canned output. Nothing
touches your own `~/.claude`, `~/.codex`, `~/.pi` or opencode config. Claude Code loads the plugin with
`--plugin-dir` and runs with `--permission-mode bypassPermissions`, so its auto-mode classifier
cannot block the stub (#1021); Codex gets the skill in `$CODEX_HOME/skills` and the rule in
`$CODEX_HOME/AGENTS.md`, opencode the same in `$XDG_CONFIG_HOME/opencode` (`opencode run
--pure --auto`, which waits for answers as `codex exec` does); Pi loads the Starbridge extension and skill with `-e` and `--skill`,
and uses the providers in `~/.pi/agent`. Cursor and Antigravity get what `starbridge setup` writes
for them, in the run's home: Cursor the skill in `~/.cursor/skills` and its hooks in
`~/.cursor/hooks.json` (`cursor-agent -p --force`), Antigravity the plugin in
`~/.gemini/config/plugins` (`agy -p --dangerously-skip-permissions`). Neither has a live session, so
they skip the `live` situations. Anthropic bills a Claude subscription used from Pi as
extra usage, so Pi runs on another model. While a non-interactive agent waits, the owner answers its first card with the
recommended option; situations with a follow-up check that it acts on the answer. An interactive
Claude Code session gets the answer as the line the mod submits.

Claude Code, the judge and `tokens.ts` run on a long-lived token from `claude setup-token`, in
`CLAUDE_CODE_OAUTH_TOKEN` or `~/.config/starbridge/secrets/claude-eval-token`: copies of
`~/.claude/.credentials.json` would each refresh on their own, and a rotated refresh token signs the
original out. Codex runs log in with an OpenAI API key (`OPENAI_API_KEY` or
`~/.config/starbridge/secrets/codex-eval-key`) for the same reason; the API bills it, not your
ChatGPT plan. Cursor takes `CURSOR_API_KEY` (or `.../secrets/cursor-eval-key`), else a login made
for the eval alone in `.../secrets/cursor-eval-home`:

```bash
env -i PATH=$PATH HOME=~/.config/starbridge/secrets/cursor-eval-home \
  XDG_CONFIG_HOME=~/.config/starbridge/secrets/cursor-eval-home/.config NO_OPEN_BROWSER=1 cursor-agent login
```

Antigravity takes `GEMINI_API_KEY` (or `.../secrets/gemini-eval-key`), else a Google sign-in made
for the eval alone: run `agy` with `HOME=~/.config/starbridge/secrets/agy-eval-home` and pick Google
OAuth. Those logins refresh in place, so the runs share them rather than copy them, one run at a
time. Cursor's free plan runs only `auto`. `TMPDIR` must be outside your home, where an
ancestor's `AGENTS.md` or `CLAUDE.md` would reach the agent. A Codex home is 60 MB, so parallel
runs can fill a small /tmp.

`grade.ts` scores each run: twelve checks read the record, five ask Claude Haiku through
`claude -p` in a throwaway config dir (stored in the record, so grading again is free). A model
provider's error, such as a rate limit, makes the run a failed run rather than a score.
`render.ts` shows cards in the real web inbox (headless Chromium) and saves a screenshot of each.

`results/299` holds the records behind #299's entry in spec/platform-facts.md, one folder per
text the agents ran: `main`, `rev3`, `heredoc` and `final`.

`results/624` holds round 2, on what changed since: option order, Done, the delivery line,
`wait --no-mark` and opencode's question and edit prompts. Its cases run in sessions that live
across the answer (`live` in `scenarios.ts`): Claude Code in tmux with the mod and `starbridge
agent`, opencode under `opencode serve` with its plugin.

```bash
TMPDIR=/var/tmp bun evals/skill/run.ts --agent claude --arms after --reps 3 \
  --only merge-order,option-order,design-pick,later-question,done-on-page,delivery-prompt,delivery-wait
TMPDIR=/var/tmp bun evals/skill/run.ts --agent opencode --arms after --reps 3 \
  --only merge-order,option-order,design-pick,later-question,done-on-page,delivery-prompt,oc-question,oc-edit
bun evals/skill/grade.ts --no-judge evals/skill/results/624/claude
```

`results/911` holds the first Claude Code run on Haiku 5.5: the skill and rule before and after
#911 allowed `AskUserQuestion` for a quick question.

`results/1008` holds `typed-answer`, where the owner answers an open card in the terminal: the
agent should withdraw it with a short `--reason`.

`results/1063` holds the skill without any harness's lines, each harness's own rule, and the
CLI's new lines (#1063), on Claude Code and opencode.

`results/964` holds the first Cursor and Antigravity runs (#964).
