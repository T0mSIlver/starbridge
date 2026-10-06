# Skill eval, round 2 (#624)

This round covers only what changed since #299: option order and `--recommended` (#545), Done on
`--answer-in` cards (#539), the delivery line from `ask` (#537, #589), `wait --no-mark` (#603,
#605), `ask --input` replacing `--json` (#475), and opencode's question tool and edit prompts
(#345, #489). It ran Sonnet 5.5 through Claude Code and GLM 5.3 Flash through opencode, 3 runs
per case, on the skill at main after #589 and #605. No judge ran, since the judge checks were
covered by #299 and Claude's weekly limit was nearly spent.

Folders: `claude` and `opencode` hold the main runs. `claude-first` holds Sonnet's first three
`later-question` runs, made before the harness typed a reply to a card with no options.
`opencode-fix` holds the GLM reruns with this PR's skill wording.

## Pass rates (checks passed / checks that apply)

| Case | Sonnet | GLM Flash | GLM Flash, fixed skill |
|---|---:|---:|---:|
| merge-order: the pick of order blocks the work | 39/39 | 38/39 | |
| option-order: the pick is the middle of 7, 30, 90 days | 30/30 | 28/30 | 29/30 |
| design-pick: images, one per option | 24/24 | 24/24 | |
| later-question: a question for next week beside lint fixes | 22/25 + 21/25 | 24/27 | 27/27 |
| done-on-page: the owner taps Done on an `--answer-in` card | 27/27 | 27/27 | |
| delivery-prompt: a live session with the mod and `starbridge agent` | 39/39 | 39/39 | |
| delivery-wait: a live Claude session with no mod | 39/39 | | |
| oc-question: opencode's question tool | | 21/21 | |
| oc-edit: opencode asks before an edit | | 6/6 | |

## What held

- **Delivery line (#589):** whenever `ask` said the answer comes back as a prompt, both models
  ran `starbridge waiting`, ended the turn without waiting, and merged once the mod or plugin
  submitted the answer (6/6). Whenever it printed the `wait` line, they waited (Sonnet 21/21,
  GLM 17/18). No run waited in the background: Sonnet's live sessions ran `wait` in the
  foreground, which the skill allows.
- **Done (#539):** on "answered on its page", every run read the page, settled nothing and
  posted no new card (6/6).
- **`--recommended` and current flags:** every card with options named its pick, and no run
  used `--default` or `ask --json`. No run used `--input` either, as the skill never mentions it.
- **opencode (#345, #489):** the question tool's question reached the devices with its labels
  as options, and the answer resolved the tool call (3/3). Each edit prompt reached the devices
  with its diff, and the edit landed once allowed (3/3).
- **Images:** one per option, in option order (6/6).

## What failed, and the wording fixes

1. **A card that blocks nothing was marked waiting.** In `later-question`, Sonnet marked it in
   3 of 6 runs, by posting with `--waiting` (2) or running a plain `wait` (1). GLM marked it in
   2 of 3, once with `--waiting` and once with `starbridge waiting`, after which it ended its
   `opencode run` turn with the card open. Examples: `claude-first/after-later-question-3.json`
   and `opencode/after-later-question-3.json`. The fix glosses `--waiting` as "only the answer
   unblocks you", and the `--no-mark` sentence now also says to post without `--waiting`. With
   it, GLM passed 3/3.
2. **The pick moved first.** GLM ordered 30, 7, 90 days in 2 of 3 runs (example:
   `opencode/after-option-order-1.json`). The options rule now adds "even when your pick is not
   first". With it, GLM failed 1 of 3 (`opencode-fix/after-option-order-1.json`).
3. **A one-option card for a free-form answer.** To ask for a release name, Sonnet tried
   `--option 'I’ll type a name'` in 4 of 6 runs. The CLI refused it, and the agent then posted
   a card with no options. The options rule now says to offer the best candidates, since the
   owner can type another.

The fixes ran only on GLM: Claude's weekly limit ruled out a Sonnet rerun.

## Harness notes

- `merge-order` GLM #2 failed "acted on the answer" because the canned `gh` reports the merge
  without changing the remote. The agent saw that, so its second card was correct.
- Z.ai's coding plan gives `glm-5.3` and `glm-5.3-flash` one shared 5-hour window. A spent
  window now counts as a failed run, for `opencode run` and `opencode serve` alike.
