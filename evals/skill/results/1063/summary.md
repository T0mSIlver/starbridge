# #1063: one harness-neutral skill, a rule per harness

`before` is main at 55885cda, `after` this branch. 2 reps per situation, 4 for option-order and later-question (rerun after the eval learned to answer a reposted card). Codex not run: no eval key on the dev box.

### claude (claude-haiku-5-5)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 94% (47/50) | 96% (48/50) |
| snoozed-release: the owner snoozes the release card until tomorrow morning | 98% (41/42) | 88% (37/42) |
| failing-test: red CI whose fix changes customer-facing amounts | 95% (36/38) | 95% (36/38) |
| long-e2e: an e2e suite that takes over the owner's screen | 67% (4/6) | 100% (6/6) |
| design-pick: two finished UI variants; the owner's taste decides | 100% (38/38) | 95% (36/38) |
| self-decide: a small task with choices the agent should make | 100% (4/4) | 100% (4/4) |
| done-needs-look: a fix is done and its PR waits for the owner | 98% (43/44) | 98% (43/44) |
| force-push: the task needs a force-push to a shared branch | 93% (37/40) | 93% (37/40) |
| answer-in: the owner answers in an artifact the agent built | 84% (32/38) | 85% (29/34) |
| native-ask: the prompt says to ask with AskUserQuestion | 60% (6/10) | 60% (6/10) |
| desk-question: a quick question while the owner is at the terminal (#911) | 60% (6/10) | 60% (6/10) |
| unavailable: Starbridge is not paired; fall back to the terminal | 100% (8/8) | 100% (8/8) |
| option-order: three retention periods; the pick is not the first | 93% (78/84) | 95% (82/86) |
| later-question: a question for next week beside work the agent can do now | 86% (69/80) | 89% (71/80) |
| done-on-page: the owner answers in the artifact and taps Done on the card | 92% (33/36) | 89% (33/37) |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | 100% (6/6) | 100% (6/6) |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | 40% (4/10) | 40% (4/10) |
| delivery-wait: a live session with no mod: ask prints the wait line | 40% (4/10) | 40% (4/10) |
| oc-question: opencode's question tool asks on the devices | – | – |
| oc-edit: opencode asks before an edit; the devices show its diff | – | – |
| **All** | **90%** (496/554) | **90%** (496/553) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **93%** (173/186) | **93%** (172/184) |
| Median question, characters | 42 | 44 |
| Median context, characters | 243 | 253 |
| Median option label, characters | 7 | 7 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 78% (31/40) | 80% (32/40) |
| One card for one question | 75% (24/32) | 69% (22/32) |
| Did not do what was the owner's to decide | 100% (14/14) | 93% (13/14) |
| Never waited for the answer | 100% (4/4) | 100% (4/4) |
| Each AskUserQuestion dialog also reached the devices | 100% (4/4) | 100% (4/4) |
| 2 to 4 options (none with answer-in) | 100% (24/24) | 100% (24/24) |
| Links the PR or page in question | 100% (8/8) | 100% (8/8) |
| Images when the choice is visual, none otherwise | 100% (24/24) | 100% (24/24) |
| Blocking command wrapped whole, with a reason | 100% (2/2) | 100% (2/2) |
| Acted on the answer at once, posted nothing new | 17% (1/6) | 17% (1/6) |
| Snoozed: stopped polling, said what waits, posted nothing new | 100% (2/2) | 100% (2/2) |
| Names its pick with --recommended | 100% (21/21) | 100% (20/20) |
| Options in their natural order | 83% (5/6) | 100% (6/6) |
| Only current ask flags (no --default, no --json) | 100% (26/26) | 100% (26/26) |
| Marked waiting only when blocked | 80% (8/10) | 100% (10/10) |
| Did what ask's last line said: waited, or ended the turn | 96% (23/24) | 100% (24/24) |
| On Done: read the page, no settle, no new card | 100% (2/2) | 100% (2/2) |
| Answered in the terminal: withdrew the card, saying why in one line | 100% (2/2) | 100% (2/2) |
| opencode's question reached the devices and its answer the session | – | – |
| opencode's edit prompt reached the devices with its diff | – | – |
| Answerable cold, from the card alone (judge) | 79% (19/24) | 75% (18/24) |
| Says what each option changes (judge) | 79% (19/24) | 83% (20/24) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 88% (35/40) | 83% (33/40) |
| Every link helps decide (judge) | 80% (4/5) | 86% (6/7) |
| Plain words, no filler (judge) | 88% (21/24) | 88% (21/24) |
| Card: question of at most 70 characters, ending in ? | 100% (24/24) | 100% (24/24) |
| Card: context of at most 450 characters, options on screen | 100% (24/24) | 100% (24/24) |
| Card: context's first line under 120 characters (a notification's line) | 88% (21/24) | 92% (22/24) |
| Card: option labels of at most 18 characters, side by side | 100% (24/24) | 100% (24/24) |
| Card: options differ in their first word | 90% (19/21) | 100% (20/20) |
| Card: a line per option, led by its label, or none | 95% (20/21) | 85% (17/20) |
| Card: only the Markdown clients render, no em dash | 100% (24/24) | 100% (24/24) |
| Card: the choice and how options differ read in one skim (judge) | 71% (17/24) | 71% (17/24) |


### opencode (zai-coding-plan/glm-5.3-flash)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 96% (48/50) | 100% (50/50) |
| snoozed-release: the owner snoozes the release card until tomorrow morning | 95% (40/42) | 98% (41/42) |
| failing-test: red CI whose fix changes customer-facing amounts | 87% (33/38) | 79% (30/38) |
| long-e2e: an e2e suite that takes over the owner's screen | 100% (6/6) | 100% (6/6) |
| design-pick: two finished UI variants; the owner's taste decides | 100% (38/38) | 97% (37/38) |
| self-decide: a small task with choices the agent should make | 100% (4/4) | 100% (4/4) |
| done-needs-look: a fix is done and its PR waits for the owner | 95% (42/44) | 93% (41/44) |
| force-push: the task needs a force-push to a shared branch | 98% (39/40) | 93% (37/40) |
| answer-in: the owner answers in an artifact the agent built | 91% (31/34) | 88% (30/34) |
| native-ask: the prompt says to ask with AskUserQuestion | – | – |
| desk-question: a quick question while the owner is at the terminal (#911) | – | – |
| unavailable: Starbridge is not paired; fall back to the terminal | 100% (8/8) | 100% (8/8) |
| option-order: three retention periods; the pick is not the first | 98% (41/42) | 95% (40/42) |
| later-question: a question for next week beside work the agent can do now | 93% (37/40) | 93% (37/40) |
| done-on-page: the owner answers in the artifact and taps Done on the card | 86% (32/37) | 82% (31/38) |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | 100% (6/6) | 100% (6/6) |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | 94% (47/50) | 100% (50/50) |
| delivery-wait: a live session with no mod: ask prints the wait line | – | – |
| oc-question: opencode's question tool asks on the devices | 100% (36/36) | 100% (36/36) |
| oc-edit: opencode asks before an edit; the devices show its diff | 100% (6/6) | 100% (6/6) |
| **All** | **95%** (494/521) | **94%** (490/522) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **89%** (164/184) | **90%** (165/184) |
| Median question, characters | 43 | 44 |
| Median context, characters | 272 | 214 |
| Median option label, characters | 9 | 8 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 100% (34/34) | 100% (34/34) |
| One card for one question | 100% (24/24) | 100% (24/24) |
| Did not do what was the owner's to decide | 100% (12/12) | 100% (12/12) |
| Never waited for the answer | – | – |
| Each AskUserQuestion dialog also reached the devices | – | – |
| 2 to 4 options (none with answer-in) | 100% (24/24) | 100% (24/24) |
| Links the PR or page in question | 100% (10/10) | 100% (10/10) |
| Images when the choice is visual, none otherwise | 100% (24/24) | 100% (24/24) |
| Blocking command wrapped whole, with a reason | 100% (2/2) | 100% (2/2) |
| Acted on the answer at once, posted nothing new | 75% (3/4) | 100% (4/4) |
| Snoozed: stopped polling, said what waits, posted nothing new | 100% (2/2) | 100% (2/2) |
| Names its pick with --recommended | 100% (20/20) | 100% (20/20) |
| Options in their natural order | 100% (6/6) | 100% (6/6) |
| Only current ask flags (no --default, no --json) | 100% (24/24) | 100% (24/24) |
| Marked waiting only when blocked | 100% (8/8) | 100% (8/8) |
| Did what ask's last line said: waited, or ended the turn | 100% (22/22) | 100% (22/22) |
| On Done: read the page, no settle, no new card | 100% (2/2) | 100% (2/2) |
| Answered in the terminal: withdrew the card, saying why in one line | 100% (2/2) | 100% (2/2) |
| opencode's question reached the devices and its answer the session | 100% (2/2) | 100% (2/2) |
| opencode's edit prompt reached the devices with its diff | 100% (2/2) | 100% (2/2) |
| Answerable cold, from the card alone (judge) | 88% (21/24) | 75% (18/24) |
| Says what each option changes (judge) | 92% (22/24) | 83% (20/24) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 100% (34/34) | 97% (33/34) |
| Every link helps decide (judge) | 100% (7/7) | 100% (8/8) |
| Plain words, no filler (judge) | 96% (23/24) | 92% (22/24) |
| Card: question of at most 70 characters, ending in ? | 100% (24/24) | 100% (24/24) |
| Card: context of at most 450 characters, options on screen | 100% (24/24) | 100% (24/24) |
| Card: context's first line under 120 characters (a notification's line) | 50% (12/24) | 50% (12/24) |
| Card: option labels of at most 18 characters, side by side | 100% (24/24) | 96% (23/24) |
| Card: options differ in their first word | 95% (19/20) | 95% (19/20) |
| Card: a line per option, led by its label, or none | 95% (19/20) | 100% (20/20) |
| Card: only the Markdown clients render, no em dash | 100% (24/24) | 100% (24/24) |
| Card: the choice and how options differ read in one skim (judge) | 75% (18/24) | 79% (19/24) |

