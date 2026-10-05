---
name: starbridge
description: "Reach your user through Starbridge. They are often away from the terminal, and Starbridge is how you reach them: a card on their phone and web page that they answer with one tap, sent back into this session. Use it instead of asking in chat whenever you need a decision that is theirs to make, or work is done or failed in a way they must act on; and wrap in `starbridge run`, unasked, any command that blocks them or matches their rules for runs. Covers when to post, how to write a card they can answer cold, what never to post, and what to do with the answer."
compatibility: The `starbridge` CLI on PATH, paired with `starbridge pair`, and the Starbridge mod loaded in this Claude Code session.
---

# Reach your user through Starbridge

Your user is often away from this terminal. Starbridge shows them a card on
their phone; they read it cold, between other things, and tap an option. The
answer comes back into this session as a prompt.

## When to post

- **A decision that is theirs.** Hard to undo (force-push, deleting data,
  publishing or sending outside the machine), spending money or a scarce
  quota, scope nobody asked for, or a choice their taste or their rules
  decide. Post it with `starbridge ask`.
- **Work they must act on.** Done and waiting for their review or merge, or
  failed in a way only they can fix. Post it as a decision whose options are
  the next step: "#52 adds CSV export and is green. Merge it?"
- **A command that blocks them** or matches their rules for runs. Wrap it in
  `starbridge run` (below). Their phone shows it running, then pass or fail.

Decide everything else yourself, act, and say what you did in your final
message. A question you could have answered costs them an interruption.
Ask in the terminal only when `starbridge` fails (not installed, not paired,
an error), and say that it failed.

## Write a card they can answer cold

They decide from the card alone, without opening this session.

- **Question.** One sentence ending in "?" that names the thing and that the
  options answer: "Run the orders migration now, or after the backup?", not
  "How should I proceed?".
- **Context.** Two to five short lines. The fact that forces the choice (the
  error line, the number, the cost), then what each option changes. Line
  breaks and `code` render; other Markdown shows as typed.
- **Options.** Two to four short labels that differ at a glance. Your pick
  first, or named with `--recommended`. No options means a typed answer; use
  that only when no list fits.
- **Default.** What you do if nobody answers, and when (`--default-at 2h`).
  Pick one you will really apply.
- **Links.** Only what they need to decide, such as the PR or issue in question, the
  page they must look at.
- **Images**, when seeing beats reading, such as the variants to pick from, the
  broken screen, a chart. One per option, in option order; the context says
  which is which.
- **One question per card.** Two related choices become one question whose
  options combine them.

Good:

```bash
starbridge ask \
  --question "Run the orders migration now, or after tonight's 18:00 backup?" \
  --context "The migration (#41, green) locks the orders table for about 4 minutes.
Now: checkouts fail for those 4 minutes, at peak hour.
After the backup: done by 18:30, with a restore point if it goes wrong." \
  --option "After the backup" --option "Now" \
  --link https://github.com/acme/shop/pull/41 \
  --default "After the backup" --default-at 1h
```

Bad: the user has to open the session to learn what the options are and what
each one costs, and the default has no time.

```bash
starbridge ask --question "How should I proceed with the PRs?" \
  --context "I've been working on the PRs and there are some conflicts between them. Let me know!" \
  --option "Option A" --option "Option B" --default "Wait"
```

Flags: `--question`, `--context` or `--context-file`, `--option` (2 to 4),
`--recommended`, `--default`, `--default-at` (`30m`, `2h`, or an ISO time),
`--image` (up to 4 PNG or JPEG files), `--link` (up to 4 HTTPS URLs),
`--answer-in`. Or `--json card.json` with `question`, `context`, `options`,
`recommended`, `default`, `defaultAt`, `images`, `links`. It prints the
decision id, such as `d_Xk3…`, and adds this session's title and links on its
own.

## Never

- Ask the same question in two places: in the terminal and on a card, or on a
  card and in an artifact.
- Ask what you can decide yourself.
- Post several cards where one would do.
- Post a wall of text, or links for reference.
- Wait for the answer: no `--wait`, no `starbridge wait`.

## Answers in an artifact

When you built a claude.ai artifact whose buttons send the pick to this
session, the user answers there. Post with `--answer-in <url>` and no
options. When its message arrives, run `starbridge settle <id>`, then act. An
artifact that is only to look at goes in `--link`, with the options on the
card. `starbridge settle <id> --outcome withdrawn` takes back a card you no
longer need, for example after the user answered in the terminal.

## After you post

Go on with the work that does not depend on the answer. When only that work
is left, end your turn, saying what waits on the card and what you will do at
its default time.

The answer arrives as a new prompt, possibly while you work on something else:

```
Answer to d_Xk3… (Run the orders migration now, or after tonight's 18:00 backup?): Now
```

Act on it right away. With no answer by the default time you get
`No answer to d_Xk3… (…) by its default time …: apply your default: After the backup`;
apply it then. If you are still working when that time passes, apply it
without waiting for that prompt. If
an answer arrives after you applied the default and differs from it, undo
what you can and follow the answer.

Post again only when the outcome changes what the user would do, for example
when the merge failed or the fix needs their call. Otherwise, say it in your
final message.

## Report a run

Wrap a command in `starbridge run`, unasked, when it blocks the user or needs
them at the machine (e2e tests that take over the screen, keyboard or
session; anything holding a device they use), or when it matches one of their
rules under "My rules for runs" in your context.

```bash
starbridge run --title "Mac e2e" --reason "takes over your screen and keyboard" \
  -- bash -c 'make build && make e2e'
```

- Wrap the whole command, chained or not, in `-- bash -c '…'`. They want to
  know when the machine is busy and when it is free again.
- `--title` is a few words. `--reason` is required: what it blocks, or the
  rule it matches.
- The output and exit code are the command's own. Progress lines such as
  `[3/7]` or `42%` reach the phone on their own.
- Run anything else as usual.

## Permission prompts

When the user turned on `starbridge permissions`, your permission prompts also
reach their phone. Give every risky Bash command a `description` that says
what it does and why.
