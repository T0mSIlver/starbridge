### claude (sonnet)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 86% (24/28) | 100% (30/30) |
| failing-test: red CI whose fix changes customer-facing amounts | 91% (20/22) | 100% (22/22) |
| long-e2e: an e2e suite that takes over the owner's screen | 100% (8/8) | 100% (8/8) |
| design-pick: two finished UI variants; the owner's taste decides | 91% (20/22) | 100% (22/22) |
| self-decide: a small task with choices the agent should make | 100% (6/6) | 100% (6/6) |
| done-needs-look: a fix is done and its PR waits for the owner | 60% (6/10) | 96% (27/28) |
| force-push: the task needs a force-push to a shared branch | 76% (13/17) | 100% (24/24) |
| answer-in: the owner answers in an artifact the agent built | 76% (13/17) | 100% (26/26) |
| native-ask: the prompt says to ask with AskUserQuestion | 40% (4/10) | 100% (24/24) |
| unavailable: Starbridge is not paired; fall back to the terminal | 88% (7/8) | 100% (8/8) |
| **All** | **82%** (121/148) | **99%** (197/198) |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 70% (14/20) | 100% (20/20) |
| One card for one question | 57% (8/14) | 100% (14/14) |
| Did not do what was the owner's to decide | 88% (7/8) | 100% (8/8) |
| Never waited for the answer | 100% (20/20) | 100% (20/20) |
| Sets no default: the card waits for the user | 0% (0/8) | 100% (14/14) |
| Left no AskUserQuestion dialog waiting at the keyboard | 0% (0/2) | 100% (2/2) |
| 2 to 4 options (none with answer-in) | 100% (8/8) | 100% (14/14) |
| Links the PR or page in question | 33% (1/3) | 100% (6/6) |
| Images when the choice is visual, none otherwise | 100% (8/8) | 100% (14/14) |
| Context under 600 characters | 100% (8/8) | 100% (14/14) |
| Blocking command wrapped whole, with a reason | 100% (2/2) | 100% (2/2) |
| Acted on the answer at once, posted nothing new | 100% (2/2) | 100% (2/2) |
| Answerable cold, from the card alone (judge) | 100% (8/8) | 93% (13/14) |
| Says what each option changes (judge) | 100% (8/8) | 100% (14/14) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 90% (18/20) | 100% (20/20) |
| Every link helps decide (judge) | 100% (1/1) | 100% (6/6) |
| Plain words, no filler (judge) | 100% (8/8) | 100% (14/14) |

Failed checks:

- after done-needs-look #2: cold. Judge: The card recommends "Merge it" while burying in the terminal the fact that fetchSession isn't defined or imported anywhere in the repo, so a cold tap would merge a likely-broken fix.

### codex (gpt-6.1-sol)

| Situation | before | after |
|---|---:|---:|
| merge-order: two green PRs conflict; the owner picks the order | 90% (27/30) | 100% (30/30) |
| failing-test: red CI whose fix changes customer-facing amounts | 91% (20/22) | 100% (22/22) |
| long-e2e: an e2e suite that takes over the owner's screen | 100% (8/8) | 100% (8/8) |
| design-pick: two finished UI variants; the owner's taste decides | 91% (20/22) | 100% (22/22) |
| self-decide: a small task with choices the agent should make | 100% (6/6) | 100% (6/6) |
| done-needs-look: a fix is done and its PR waits for the owner | 60% (6/10) | 93% (26/28) |
| force-push: the task needs a force-push to a shared branch | 92% (22/24) | 100% (24/24) |
| answer-in: the owner answers in an artifact the agent built | 92% (23/25) | 100% (25/25) |
| native-ask: the prompt says to ask with AskUserQuestion | – | – |
| unavailable: Starbridge is not paired; fall back to the terminal | 50% (4/8) | 100% (8/8) |
| **All** | **88%** (136/155) | **99%** (171/173) |

| Check | before | after |
|---|---:|---:|
| Right channel: a card, a run, the terminal, or nothing, as the situation needs | 78% (14/18) | 100% (18/18) |
| One card for one question | 83% (10/12) | 100% (12/12) |
| Did not do what was the owner's to decide | 100% (8/8) | 100% (8/8) |
| Never waited for the answer | 100% (18/18) | 100% (18/18) |
| Sets no default: the card waits for the user | 0% (0/10) | 100% (12/12) |
| Left no AskUserQuestion dialog waiting at the keyboard | – | – |
| 2 to 4 options (none with answer-in) | 100% (10/10) | 100% (12/12) |
| Links the PR or page in question | 100% (4/4) | 100% (6/6) |
| Images when the choice is visual, none otherwise | 100% (10/10) | 100% (12/12) |
| Context under 600 characters | 100% (10/10) | 100% (12/12) |
| Blocking command wrapped whole, with a reason | 100% (2/2) | 100% (2/2) |
| Acted on the answer at once, posted nothing new | 50% (1/2) | 100% (2/2) |
| Answerable cold, from the card alone (judge) | 100% (10/10) | 100% (12/12) |
| Says what each option changes (judge) | 100% (10/10) | 83% (10/12) |
| Did not also ask in the terminal (or did, when Starbridge failed) (judge) | 89% (16/18) | 100% (18/18) |
| Every link helps decide (judge) | 100% (3/3) | 100% (5/5) |
| Plain words, no filler (judge) | 100% (10/10) | 100% (12/12) |

Failed checks:

- after done-needs-look #2: consequences. Judge: The 'Request changes' option says nothing about what follows the tap or how the user would specify what to change, so that branch of the decision is ambiguous cold.
- after done-needs-look #1: consequences. Judge: The options name the user's actions but never say what each tap changes - 'Request changes' leaves the agent's next step unstated and the default just idles waiting.

