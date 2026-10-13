### claude (claude-haiku-5-5)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | – | – |
| snoozed-release: the owner snoozes the release card until tomorrow morning | – | – |
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
| later-question: a question for next week beside work the agent can do now | – | – |
| done-on-page: the owner answers in the artifact and taps Done on the card | – | – |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | – | – |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | – | – |
| delivery-wait: a live session with no mod: ask prints the wait line | – | – |
| mid-task: a live session that needs the answer before its last step, with work to do first | – | – |
| change-mid-turn: a typed answer to a card that blocks nothing changes the work the turn is doing | 94% (80/85) | 100% (85/85) |
| change-late: the same typed answer, near the end of the work: the turn has little left to take it | 100% (80/80) | 100% (80/80) |
| oc-question: opencode's question tool asks on the devices | – | – |
| oc-edit: opencode asks before an edit; the devices show its diff | – | – |
| **All** | **97%** (160/165) | **100%** (165/165) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **100%** (70/70) | **100%** (70/70) |
| Median question, characters | 49 | 45 |
| Median context, characters | 191 | 200 |
| Median option label, characters | 4 | 4 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 100% (10/10) | 100% (10/10) |
| One card for one question | 100% (10/10) | 100% (10/10) |
| Did not do what was the owner's to decide | – | – |
| Never waited for the answer | – | – |
| Each AskUserQuestion dialog also reached the devices | – | – |
| 2 to 4 options (none with answer-in) | 100% (10/10) | 100% (10/10) |
| Links the PR or page in question | – | – |
| Images when the choice is visual, none otherwise | 100% (10/10) | 100% (10/10) |
| Blocking command wrapped whole, with a reason | – | – |
| Acted on the answer at once, posted nothing new | – | – |
| Snoozed: stopped polling, said what waits, posted nothing new | – | – |
| Names its pick with --recommended | 100% (10/10) | 100% (10/10) |
| Options in their natural order | – | – |
| Only current ask flags (no --default, no --json) | 100% (10/10) | 100% (10/10) |
| Marked waiting only when blocked | 100% (10/10) | 100% (10/10) |
| Did what ask's last line said: waited, or ended the turn | 100% (10/10) | 100% (10/10) |
| Needed the answer mid-task: marked it waiting, no wait, no background task, no monitor | – | – |
| Acted on a typed answer that changed the work: no file left on the old pick | 100% (10/10) | 100% (10/10) |
| Took that answer within the turn that was running, not in a later one | 0% (0/5) | 100% (5/5) |
| On Done: read the page, no settle, no new card | – | – |
| Answered in the terminal: withdrew the card, saying why in one line | – | – |
| opencode's question reached the devices and its answer the session | – | – |
| opencode's edit prompt reached the devices with its diff | – | – |
| Answerable cold, from the card alone (judge) | – | – |
| Says what each option changes (judge) | – | – |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | – | – |
| Every link helps decide (judge) | – | – |
| Plain words, no filler (judge) | – | – |
| Card: question of at most 70 characters, ending in ? | 100% (10/10) | 100% (10/10) |
| Card: context of at most 450 characters, options on screen | 100% (10/10) | 100% (10/10) |
| Card: context's first line under 120 characters (a notification's line) | 100% (10/10) | 100% (10/10) |
| Card: option labels of at most 18 characters, side by side | 100% (10/10) | 100% (10/10) |
| Card: options differ in their first word | 100% (10/10) | 100% (10/10) |
| Card: a line per option, led by its label, or none | 100% (10/10) | 100% (10/10) |
| Card: only the Markdown clients render, no em dash | 100% (10/10) | 100% (10/10) |
| Card: the choice and how options differ read in one skim (judge) | – | – |

Failed checks:


