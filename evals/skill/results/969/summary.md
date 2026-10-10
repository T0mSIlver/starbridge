# #969: cards that read in seconds on a phone

Seven card situations (merge-order, failing-test, design-pick, done-needs-look, force-push,
option-order, later-question), 2 reps each, on the smallest model of each harness. "Before" is
the skill on main; "first" is the first rewrite (`claude/`, `opencode/` after arm); "final" is
the skill as merged (`claude-v2/`, `opencode-v2/`), which skips option lines that say nothing
and asks for a short first line. Graded with `grade.ts` and its Haiku judge.

| Haiku 5.5 (Claude Code) | before | first | final |
|---|---:|---:|---:|
| Card checks passed | 83% | 89% | **96%** |
| Question within 70 characters | 71% | 93% | 93% |
| Context within 450 characters | 93% | 100% | 100% |
| First line within 120 characters | 64% | 71% | 100% |
| Labels within 18 characters | 79% | 100% | 100% |
| A line per option, or none | 79% | 86% | 93% |
| Reads in one skim (judge) | 79% | 71% | 79% |
| Answerable cold (judge) | 86% | 71% | 86% |
| Median question / context, characters | 55 / 331 | 46 / 300 | 44 / 300 |
| All checks, every situation | 89% | 90% | 95% |

| glm-5.3-flash (opencode) | before | first | final |
|---|---:|---:|---:|
| Card checks passed | 80% | 88% | **92%** |
| Question within 70 characters | 62% | 100% | 100% |
| Context within 450 characters | 92% | 100% | 100% |
| First line within 120 characters | 69% | 50% | 36% |
| Labels within 18 characters | 69% | 100% | 100% |
| A line per option, or none | 85% | 93% | 100% |
| Only the rendered Markdown, no em dash | 77% | 79% | 100% |
| Reads in one skim (judge) | 92% | 79% | 100% |
| Answerable cold (judge) | 77% | 71% | 100% |
| Median question / context, characters | 62 / 286 | 40 / 295 | 52 / 273 |
| All checks, every situation | 88% | 91% | 96% |

The first rewrite made both models write a line per option even for names to pick from
("**Driftwood:** from NAMES.md" three times), which the judge marked down. glm-5.3-flash still
opens with a long first line: the fact and its cause in one sentence of 130 to 170 characters.
The whole card stays within 450 characters, so this costs the notification's one line, not the
fold. With 2 reps a judge check moves 7 points per run.
