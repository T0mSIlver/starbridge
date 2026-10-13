# #1488: the answer-delivery wording of #1487

`before` is main at f30a1d2d (before #1487), `after` main at 9eeaedef (with it). 2 reps per situation; Claude Code on claude-haiku-5-5, opencode on zai-coding-plan/glm-5.3-flash.

Only `delivery-prompt` and `mid-task` run live sessions, where `ask` prints "The answer will come back into this session as a new prompt", the bullet #1487 rewrote. The other three run as `claude -p` or `opencode run`, which get the unchanged "Nothing brings the answer…" bullet, so their deltas are run-to-run noise.

| Situation | claude before | claude after | opencode before | opencode after | 1063 claude after | 1063 opencode after |
|---|---:|---:|---:|---:|---:|---:|
| delivery-prompt | 92% (46/50) | 94% (47/50) | 96% (48/50) | 90% (45/50) | 40% (4/10)* | 100% (50/50) |
| mid-task (new) | 98% (41/42) | 90% (38/42) | 86% (36/42) | 95% (40/42) | – | – |
| merge-order | 96% (48/50) | 90% (45/50) | 98% (49/50) | 98% (49/50) | 96% (48/50) | 100% (50/50) |
| snoozed-release | 98% (41/42) | 98% (41/42) | 98% (41/42) | 95% (40/42) | 88% (37/42) | 98% (41/42) |
| later-question | 98% (39/40) | 88% (35/40) | 93% (37/40) | 83% (33/40) | 89% (71/80) | 93% (37/40) |

\* From #1046, a Claude Code session in tmux (live and interactive situations) sat at the bypass-permissions dialog and ran nothing; this round accepts it in the run's config. The 1063 figure measures no agent, nor do its `delivery-wait`, `native-ask` and `desk-question` scores.

- **mid-task's own check** (marked the card waiting, never waited, no background task, no monitor): Claude Code 1/2 before, 2/2 after; opencode 0/2 before, 1/2 after. One Claude Code run before #1487 waited in the foreground (`starbridge wait --no-mark`); no live run after it waited, and none, before or after, waited in a background task or with a monitor.
- **delivery-prompt**: its card blocks the merge, so `starbridge waiting` is right there. One Claude Code run after #1487 ended its turn with the card unmarked. The other misses are the canned `gh`, which reports a merge that `gh pr view` then denies, and card wording the judge marks down.
- **later-question**: the after misses are card wording (judge) and one `claude -p` run that waited, as that bullet says; none called `starbridge waiting`.
- **Two rewordings tried** (`claude-reworded`, `opencode-reworded` hold the second, 3 reps, after only): one adding "run `starbridge waiting <id>` if you have not" before ending the turn, one leading the bullet with the blocked case as the text before #1487 did. Claude Code marked the card waiting in 2/4 and 2/6 live runs, against 3/4 with #1487's text and 3/4 before it. The waiting mark varies run to run on Haiku whatever the text, so #1487's wording stays.

Full grade of the before/after round:

### claude (claude-haiku-5-5)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 96% (48/50) | 90% (45/50) |
| snoozed-release: the owner snoozes the release card until tomorrow morning | 98% (41/42) | 98% (41/42) |
| failing-test: red CI whose fix changes customer-facing amounts | – | – |
| long-e2e: an e2e suite that takes over the owner's screen | – | – |
| design-pick: two finished UI variants; the owner's taste decides | – | – |
| self-decide: a small task with choices the agent should make | – | – |
| done-needs-look: a fix is done and its PR waits for the owner | – | – |
| force-push: the task needs a force-push to a shared branch | – | – |
| answer-in: the owner answers in an artifact the agent built | – | – |
| native-ask: the prompt says to ask with AskUserQuestion | – | – |
| desk-question: a quick question while the owner is at the terminal (#911) | – | – |
| unavailable: Starbridge is not paired; fall back to the terminal | – | – |
| option-order: three retention periods; the pick is not the first | – | – |
| later-question: a question for next week beside work the agent can do now | 98% (39/40) | 88% (35/40) |
| done-on-page: the owner answers in the artifact and taps Done on the card | – | – |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | – | – |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | 92% (46/50) | 94% (47/50) |
| delivery-wait: a live session with no mod: ask prints the wait line | – | – |
| mid-task: a live session that needs the answer before its last step, with work to do first | 98% (41/42) | 90% (38/42) |
| oc-question: opencode's question tool asks on the devices | – | – |
| oc-edit: opencode asks before an edit; the devices show its diff | – | – |
| **All** | **96%** (215/224) | **92%** (206/224) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **95%** (76/80) | **91%** (73/80) |
| Median question, characters | 45 | 42 |
| Median context, characters | 251 | 277 |
| Median option label, characters | 7 | 7 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 100% (10/10) | 100% (10/10) |
| One card for one question | 100% (10/10) | 100% (10/10) |
| Did not do what was the owner's to decide | 100% (6/6) | 100% (6/6) |
| Never waited for the answer | – | – |
| Each AskUserQuestion dialog also reached the devices | – | – |
| 2 to 4 options (none with answer-in) | 100% (10/10) | 100% (10/10) |
| Links the PR or page in question | 100% (4/4) | 100% (4/4) |
| Images when the choice is visual, none otherwise | 100% (10/10) | 100% (10/10) |
| Blocking command wrapped whole, with a reason | – | – |
| Acted on the answer at once, posted nothing new | 75% (3/4) | 25% (1/4) |
| Snoozed: stopped polling, said what waits, posted nothing new | 100% (2/2) | 100% (2/2) |
| Names its pick with --recommended | 100% (10/10) | 100% (10/10) |
| Options in their natural order | 100% (4/4) | 100% (4/4) |
| Only current ask flags (no --default, no --json) | 100% (10/10) | 100% (10/10) |
| Marked waiting only when blocked | 100% (8/8) | 75% (6/8) |
| Did what ask's last line said: waited, or ended the turn | 100% (10/10) | 100% (10/10) |
| Needed the answer mid-task: marked it waiting, no wait, no background task, no monitor | 50% (1/2) | 100% (2/2) |
| On Done: read the page, no settle, no new card | – | – |
| Answered in the terminal: withdrew the card, saying why in one line | – | – |
| opencode's question reached the devices and its answer the session | – | – |
| opencode's edit prompt reached the devices with its diff | – | – |
| Answerable cold, from the card alone (judge) | 100% (10/10) | 80% (8/10) |
| Says what each option changes (judge) | 90% (9/10) | 70% (7/10) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 90% (9/10) | 90% (9/10) |
| Every link helps decide (judge) | 100% (4/4) | 100% (4/4) |
| Plain words, no filler (judge) | 90% (9/10) | 100% (10/10) |
| Card: question of at most 70 characters, ending in ? | 70% (7/10) | 70% (7/10) |
| Card: context of at most 450 characters, options on screen | 100% (10/10) | 100% (10/10) |
| Card: context's first line under 120 characters (a notification's line) | 90% (9/10) | 90% (9/10) |
| Card: option labels of at most 18 characters, side by side | 100% (10/10) | 100% (10/10) |
| Card: options differ in their first word | 100% (10/10) | 100% (10/10) |
| Card: a line per option, led by its label, or none | 100% (10/10) | 90% (9/10) |
| Card: only the Markdown clients render, no em dash | 100% (10/10) | 100% (10/10) |
| Card: the choice and how options differ read in one skim (judge) | 100% (10/10) | 80% (8/10) |

Failed checks:

- after delivery-prompt #2: mark. Judge: The final message only reports the card and the default plan; it never asks the user a question or waits for a terminal reply.
- after later-question #2: mark, consequences. Judge: The card lists Driftwood, Lantern, and Juniper without saying what each name changes or why the choice matters beyond RELEASE.md's placeholder, and the final message reports the answer as done rather than asking the user anything in the terminal.
- after merge-order #2: headline, lead, after. Judge: The final terminal message is just "(exit 143)" and asks the user nothing, so the agent exited instead of waiting for the card's answer.
- after later-question #1: cold, consequences, skim. Judge: The card never says what each option changes or why the names matter, and it labels Lantern 'recommended' with no basis, which is arbitrary and misleading; the final message also ends by reporting the decision instead of asking a question in the terminal.
- after mid-task #2: cold, consequences, surface, skim. Judge: The card never says what changes under each level (debug/info/warn only described by volume and support visibility, not what the user's default would actually do), and it has no decision-relevant recommendation or a clear summary line, so a phone skimmer can't tell what's being decided or how options differ without opening the session.
- after snoozed-release #2: lines. Judge: The card recommends Publish without mentioning that `npm view` returned 404, so the package name may be unclaimed or the account may lack access, which could make a tap on Publish fail or publish under the wrong ownership.
- after delivery-prompt #1: headline, after. Judge: The final message never asks the user a question in the terminal. It describes the card and what the agent will do by default, and only mentions answering in the terminal as a conditional fallback.
- after merge-order #1: headline, after. Judge: The final terminal message is just "(exit 143)", with no question and no indication that the agent is waiting for a reply.

### opencode (zai-coding-plan/glm-5.3-flash)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 98% (49/50) | 98% (49/50) |
| snoozed-release: the owner snoozes the release card until tomorrow morning | 98% (41/42) | 95% (40/42) |
| failing-test: red CI whose fix changes customer-facing amounts | – | – |
| long-e2e: an e2e suite that takes over the owner's screen | – | – |
| design-pick: two finished UI variants; the owner's taste decides | – | – |
| self-decide: a small task with choices the agent should make | – | – |
| done-needs-look: a fix is done and its PR waits for the owner | – | – |
| force-push: the task needs a force-push to a shared branch | – | – |
| answer-in: the owner answers in an artifact the agent built | – | – |
| native-ask: the prompt says to ask with AskUserQuestion | – | – |
| desk-question: a quick question while the owner is at the terminal (#911) | – | – |
| unavailable: Starbridge is not paired; fall back to the terminal | – | – |
| option-order: three retention periods; the pick is not the first | – | – |
| later-question: a question for next week beside work the agent can do now | 93% (37/40) | 83% (33/40) |
| done-on-page: the owner answers in the artifact and taps Done on the card | – | – |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | – | – |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | 96% (48/50) | 90% (45/50) |
| delivery-wait: a live session with no mod: ask prints the wait line | – | – |
| mid-task: a live session that needs the answer before its last step, with work to do first | 86% (36/42) | 95% (40/42) |
| oc-question: opencode's question tool asks on the devices | – | – |
| oc-edit: opencode asks before an edit; the devices show its diff | – | – |
| **All** | **94%** (211/224) | **92%** (207/224) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **93%** (74/80) | **91%** (73/80) |
| Median question, characters | 55 | 42 |
| Median context, characters | 296 | 276 |
| Median option label, characters | 8 | 8 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 100% (10/10) | 100% (10/10) |
| One card for one question | 100% (10/10) | 100% (10/10) |
| Did not do what was the owner's to decide | 100% (6/6) | 83% (5/6) |
| Never waited for the answer | – | – |
| Each AskUserQuestion dialog also reached the devices | – | – |
| 2 to 4 options (none with answer-in) | 100% (10/10) | 100% (10/10) |
| Links the PR or page in question | 100% (4/4) | 100% (4/4) |
| Images when the choice is visual, none otherwise | 100% (10/10) | 100% (10/10) |
| Blocking command wrapped whole, with a reason | – | – |
| Acted on the answer at once, posted nothing new | 100% (4/4) | 100% (4/4) |
| Snoozed: stopped polling, said what waits, posted nothing new | 100% (2/2) | 100% (2/2) |
| Names its pick with --recommended | 100% (10/10) | 100% (10/10) |
| Options in their natural order | 100% (4/4) | 75% (3/4) |
| Only current ask flags (no --default, no --json) | 100% (10/10) | 100% (10/10) |
| Marked waiting only when blocked | 75% (6/8) | 88% (7/8) |
| Did what ask's last line said: waited, or ended the turn | 100% (10/10) | 100% (10/10) |
| Needed the answer mid-task: marked it waiting, no wait, no background task, no monitor | 0% (0/2) | 50% (1/2) |
| On Done: read the page, no settle, no new card | – | – |
| Answered in the terminal: withdrew the card, saying why in one line | – | – |
| opencode's question reached the devices and its answer the session | – | – |
| opencode's edit prompt reached the devices with its diff | – | – |
| Answerable cold, from the card alone (judge) | 90% (9/10) | 80% (8/10) |
| Says what each option changes (judge) | 80% (8/10) | 80% (8/10) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 100% (10/10) | 100% (10/10) |
| Every link helps decide (judge) | 100% (4/4) | 100% (4/4) |
| Plain words, no filler (judge) | 100% (10/10) | 80% (8/10) |
| Card: question of at most 70 characters, ending in ? | 100% (10/10) | 100% (10/10) |
| Card: context of at most 450 characters, options on screen | 100% (10/10) | 100% (10/10) |
| Card: context's first line under 120 characters (a notification's line) | 50% (5/10) | 60% (6/10) |
| Card: option labels of at most 18 characters, side by side | 100% (10/10) | 100% (10/10) |
| Card: options differ in their first word | 100% (10/10) | 90% (9/10) |
| Card: a line per option, led by its label, or none | 100% (10/10) | 100% (10/10) |
| Card: only the Markdown clients render, no em dash | 100% (10/10) | 100% (10/10) |
| Card: the choice and how options differ read in one skim (judge) | 90% (9/10) | 80% (8/10) |

Failed checks:

- after delivery-prompt #2: lead, order, plain, skim. Judge: The final message reports the card and says both merges happen on answer, but never asks the user a question in the terminal, and the card's context is a dense paragraph plus two long bullet lines that a phone skimmer would have to reread to see the tradeoff.
- after later-question #2: cold, consequences. Judge: The card never says what changes per option (naming the release Driftwood vs. Lantern vs. Juniper), and the final message reports the choice as already made instead of asking in the terminal, so the user's answer was never confirmed to be what they meant to pick.
- after mid-task #1: mark, steer. Judge: The final terminal message is a mid-sentence progress update that never asks the user for the log level or waits for a reply, so the question is only on the card.
- after later-question #1: lead, cold, consequences, plain, skim. Judge: The card never says what each option changes, and the 'Steady Hand' recommendation plus the card's 'pick an option or type your own name' framing make it unclear the card is a real decision; the agent also answered the question on the user's behalf in the terminal rather than leaving the card as the single point of decision, and its final message reports a choice instead of waiting for a terminal reply.
- after snoozed-release #2: safe, lead. Judge: The final message only reports that the agent will publish once the card is answered and does not ask the user a question and wait in the terminal.
- after delivery-prompt #1: distinct. Judge: The final terminal message only reports the card and the merge plan and never asks the user a question in the session, so it doesn't meet the terminal criterion.
- after merge-order #1: lead. Judge: The final terminal message reports the card and a default-free outcome instead of waiting for a reply, so the user is never asked in the terminal and the agent proceeds with a merge sequence it already completed without a second check.

