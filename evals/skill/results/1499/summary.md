# #1499: the ask-tool sentence in each harness's rule

`before` is main at e2771795, `after` this branch. Claude Code on claude-haiku-5-5, 2 reps per situation.

The card's question each AskUserQuestion run put on the devices:

| Run | before | after |
|---|---|---|
| native-ask #1 | Which one should the card title use? | Which error tracking service should we wire into the web app? |
| native-ask #2 | Which title should this card get? | Which error tracking service should the web app use? |
| desk-question #1 | Should the dark theme follow the system setting, or be a toggle in the menu? src/theme.js currently exports … | Should the dark theme follow the system setting or use a menu toggle? |
| desk-question #2 | Which option should title this card? | Follow system setting, or add a menu toggle? |

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
| native-ask: the prompt says to ask with AskUserQuestion | 74% (28/38) | 95% (36/38) |
| desk-question: a quick question while the owner is at the terminal (#911) | 79% (30/38) | 100% (38/38) |
| unavailable: Starbridge is not paired; fall back to the terminal | – | – |
| option-order: three retention periods; the pick is not the first | – | – |
| later-question: a question for next week beside work the agent can do now | – | – |
| done-on-page: the owner answers in the artifact and taps Done on the card | – | – |
| typed-answer: the owner answers an open card in the terminal; the agent withdraws it | – | – |
| delivery-prompt: a live session whose mod brings the answer back as a prompt | – | – |
| delivery-wait: a live session with no mod: ask prints the wait line | – | – |
| mid-task: a live session that needs the answer before its last step, with work to do first | – | – |
| oc-question: opencode's question tool asks on the devices | – | – |
| oc-edit: opencode asks before an edit; the devices show its diff | – | – |
| **All** | **76%** (58/76) | **97%** (74/76) |

| Card readability | before | after |
|---|---:|---:|
| Card checks passed | **53%** (17/32) | **94%** (30/32) |
| Median question, characters | 36 | 52 |
| Median context, characters | 503 | 219 |
| Median option label, characters | 20 | 18 |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 100% (4/4) | 100% (4/4) |
| One card for one question | 100% (4/4) | 100% (4/4) |
| Did not do what was the owner's to decide | – | – |
| Never waited for the answer | 100% (4/4) | 100% (4/4) |
| Each AskUserQuestion dialog also reached the devices | 100% (4/4) | 100% (4/4) |
| 2 to 4 options (none with answer-in) | 100% (4/4) | 100% (4/4) |
| Links the PR or page in question | – | – |
| Images when the choice is visual, none otherwise | 100% (4/4) | 100% (4/4) |
| Blocking command wrapped whole, with a reason | – | – |
| Acted on the answer at once, posted nothing new | – | – |
| Snoozed: stopped polling, said what waits, posted nothing new | – | – |
| Names its pick with --recommended | 100% (4/4) | 100% (4/4) |
| Options in their natural order | – | – |
| Only current ask flags (no --default, no --json) | – | – |
| Marked waiting only when blocked | – | – |
| Did what ask's last line said: waited, or ended the turn | – | – |
| Needed the answer mid-task: marked it waiting, no wait, no background task, no monitor | – | – |
| On Done: read the page, no settle, no new card | – | – |
| Answered in the terminal: withdrew the card, saying why in one line | – | – |
| opencode's question reached the devices and its answer the session | – | – |
| opencode's edit prompt reached the devices with its diff | – | – |
| Answerable cold, from the card alone (judge) | 100% (4/4) | 100% (4/4) |
| Says what each option changes (judge) | 100% (4/4) | 100% (4/4) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 100% (4/4) | 100% (4/4) |
| Every link helps decide (judge) | – | – |
| Plain words, no filler (judge) | 25% (1/4) | 100% (4/4) |
| Card: question of at most 70 characters, ending in ? | 75% (3/4) | 100% (4/4) |
| Card: context of at most 450 characters, options on screen | 25% (1/4) | 100% (4/4) |
| Card: context's first line under 120 characters (a notification's line) | 0% (0/4) | 100% (4/4) |
| Card: option labels of at most 18 characters, side by side | 0% (0/4) | 50% (2/4) |
| Card: options differ in their first word | 100% (4/4) | 100% (4/4) |
| Card: a line per option, led by its label, or none | 100% (4/4) | 100% (4/4) |
| Card: only the Markdown clients render, no em dash | 100% (4/4) | 100% (4/4) |
| Card: the choice and how options differ read in one skim (judge) | 25% (1/4) | 100% (4/4) |

Failed checks:

- after native-ask #1: labels. Judge: The final terminal message is empty, so the agent never asks the question or waits for a reply in the terminal, which the card-only flow depends on.
- after native-ask #2: labels. Judge: The final terminal message is empty, so the agent never asks in the terminal or waits for a reply; the card is the only question.

