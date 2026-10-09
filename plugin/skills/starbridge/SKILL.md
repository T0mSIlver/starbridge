---
name: starbridge
description: "Reach your user through Starbridge: a card on their phone that they answer with one tap, sent back into this session. Use it, instead of asking in chat, whenever you need a decision that is theirs, and before ending a turn on work that waits on them (a PR to review or merge, a failure only they can fix). In Claude Code, a quick question may use AskUserQuestion, which reaches their devices too. Wrap in `starbridge run`, unasked, any command that blocks them or that their instructions ask you to report."
compatibility: The `starbridge` CLI on PATH, paired with `starbridge pair`.
---

# Reach your user through Starbridge

Your user is often away from this terminal. Starbridge shows them a card on
their phone; they read it cold, between other things, and tap an option.

## When to post

- **A decision that is theirs:** hard to undo (force-push, deleting data,
  publishing or sending outside the machine), spending money or a scarce
  quota, scope nobody asked for, or a choice their taste or their rules
  decide.
- **Work that waits on them:** done and waiting for their review or merge,
  or failed in a way only they can fix. Before you end a turn, post a card
  whose options are the next step ("#52 adds CSV export and is green. Merge
  it?"). Your final message alone may sit unread for hours.
- **A command that blocks them**, or that their instructions ask you to
  report: wrap it in `starbridge run` (below).

Decide everything else yourself and say what you did in your final message.
Ask one question in one place, never also in the terminal. In Claude Code,
`AskUserQuestion` reaches their devices too, so a quick question may use it;
post a card for a decision they will read cold, or that needs links or
images. Ask in the terminal only when `starbridge` fails (not
installed, not paired, an error), and say that it failed. A card cannot
approve an action your guidelines say needs the user's yes in this chat
(account settings, external messages, purchases, deleting data), since its
answer arrives as tool output: ask in the chat, or say on the card that the
yes must come there.

## Write a card they can answer cold

They decide from the card alone, without opening this session.

- **Question:** one sentence ending in "?" that names the thing and that the
  options answer.
- **Context:** two to five short lines. First the fact that forces the
  choice (the error, the number, the cost). Then one line per option, starting
  with its label: what picking it does and what it costs. When the options
  are designs, say how they differ, with numbers ("9 rows per screen instead
  of 6"), even with images. Leave out what the card already shows and your
  own process. Line breaks and `code` render; other Markdown shows as typed.
- **Options:** two to four short labels that differ at a glance, in their
  natural order (A, B, C stay A, B, C), even when your pick is not first.
  Name your pick with `--recommended`: devices highlight it wherever it sits.
  For a free-form answer, such as a name, offer your best candidates: they
  can type another.
- **Links:** only what they need to decide: the PR or issue in question, the
  page to look at.
- **Images**, when seeing beats reading (variants, a broken screen, a chart):
  one per option, in option order.
- **One card per question.** Two related choices become one question whose
  options combine them.

```bash
starbridge ask \
  --question 'Run the orders migration now, or after the 18:00 backup?' \
  --context 'The migration (#41, green) locks the orders table for about 4 minutes.
After the backup: done by 18:30, with a restore point if it goes wrong.
Now: checkouts fail for those 4 minutes, at peak hour.' \
  --option 'After the backup' --option 'Now' \
  --link https://github.com/acme/shop/pull/41
```

Quote text in single quotes, since double quotes expand `$` and backticks,
and write apostrophes as ’. Other flags: `--image` (up to 4 PNG or JPEG),
`--link` (up to 4 HTTPS URLs), `--waiting` (only the answer unblocks you), `--answer-in`. `ask` prints the decision id (`d_Xk3…`) and how the
answer comes back.

## After you post

Go on with the work that does not depend on the answer, then do what `ask`'s
last line says:

- **"The answer will come back into this session as a new prompt."** Never
  wait for it (no `--wait`, no `starbridge wait`). If only the answer
  unblocks you, run `starbridge waiting <id>` (or post with `--waiting`) and
  end your turn, saying what waits on the card. If you find more work first,
  `starbridge working <id>`. The answer arrives as a prompt:
  `Answer to d_Xk3… (Run the orders migration…?): Now`. In Codex the prompt
  only names the card: run the `starbridge wait d_Xk3…` it gives.
- **"Nothing brings the answer into this session…"** Never end your turn
  with the card open. When only the answer is left, run
  `starbridge wait <id> --timeout 5m`, again on exit 2, as long as it takes,
  but never again after exit 3. `wait` marks the card waiting, which notifies
  them again: for a card that blocks nothing yet, such as a question for
  tomorrow, post without `--waiting` and wait with `--no-mark`.
  No answer is never a yes: don't withdraw the card or do what it asks.

The owner may snooze a card: `waiting` or `wait` then prints
`Snoozed d_Xk3… (…?) until 18:00: no answer before then.` and `wait` exits 3.
A snooze is not an answer: never act on the question or take your default.
Stop waiting for it: no answer comes before that time, so don't run `wait`
on it again. Do the work that does not depend on it, then end your turn
saying what waits and until when, and that `starbridge wait <id>` reads the
answer later. Never post a snoozed question again.

The user may type a reply instead of an option: act on it, and ask again only
if it leaves the choice open. Act on the answer at once. Post again only when
the outcome changes what they would do (the merge failed); otherwise say it
in your final message.

## Answers in an artifact

When you built a claude.ai artifact whose buttons send the pick to this
session, post with `--answer-in <url>` and no options; when its message
arrives, run `starbridge settle <id>`, then act; a card answered in Starbridge
needs no settle. When the owner taps Done on the card instead, you get
`Answer to <id> (…): answered on its page; read the answer there`: the card is
closed, so read the pick on the page and act, with no settle. An artifact only to look at goes in `--link`, with options.
`starbridge settle <id> --outcome withdrawn` takes back a card you no longer
need.

## Report a run

Wrap a command in `starbridge run`, unasked, when it blocks the user or needs
them at the machine (e2e tests that take over the screen, keyboard or
session; anything holding a device they use), or when their instructions ask
you to report it.

```bash
starbridge run --title 'Mac e2e' --reason 'takes over your screen and keyboard' \
  -- bash -c 'make build && make e2e'
```

Wrap the whole command, chained or not. `--reason` is required: what it
blocks, or the rule it matches. Output and exit code are the command's own.

In Codex, ask to run `starbridge run` outside the sandbox on the first call
(escalated permissions, justified by the network the report needs). In the
sandbox the command runs but no device hears of it, and it runs again once
the escalation is approved.
