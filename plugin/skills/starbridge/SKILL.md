---
name: starbridge
description: "Reach your user through Starbridge. They are often away from the terminal, and Starbridge is how you reach them: a card on their phone and web page that they answer with one tap, sent back into this session. Use it, instead of asking in chat or with AskUserQuestion, whenever you need a decision that is theirs to make, and before ending a turn on work that waits on them (a PR to review or merge, a failure only they can fix); and wrap in `starbridge run`, unasked, any command that blocks them or that their instructions ask you to report. Covers when to post, how to write a card they can answer cold, what never to post, and what to do with the answer."
compatibility: The `starbridge` CLI on PATH, paired with `starbridge pair`. Answers come back as prompts in Claude Code with the Starbridge plugin, and in Codex CLI sessions when `starbridge agent` runs; elsewhere the agent waits for them with `starbridge wait`.
---

# Reach your user through Starbridge

Your user is often away from this terminal. Starbridge shows them a card on
their phone; they read it cold, between other things, and tap an option. How
the answer comes back depends on your agent: see "After you post".

## When to post

- **A decision that is theirs.** Hard to undo (force-push, deleting data,
  publishing or sending outside the machine), spending money or a scarce
  quota, scope nobody asked for, or a choice their taste or their rules
  decide. Post it with `starbridge ask`.
- **Work that waits on them.** Done and waiting for their review or merge, or
  failed in a way only they can fix. Before you end a turn, check whether
  anything you leave waits on the user; if it does, post a card whose options
  are the next step: "#52 adds CSV export and is green. Merge it?" Your final
  message alone may sit unread for hours.
- **A command that blocks them**, or that their instructions ask you to
  report. Wrap it in `starbridge run` (below). Their phone shows it running,
  then pass or fail.

Decide everything else yourself, act, and say what you did in your final
message. A question you could have answered costs them an interruption.
Never ask in the terminal or with the `AskUserQuestion` tool; while Starbridge
works, a hook turns that tool away. Ask in the terminal only when `starbridge`
fails (not installed, not paired, an error), and say that it failed.

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
  --link https://github.com/acme/shop/pull/41
```

Bad: the user has to open the session to learn what the options are and what
each one costs.

```bash
starbridge ask --question "How should I proceed with the PRs?" \
  --context "I've been working on the PRs and there are some conflicts between them. Let me know!" \
  --option "Option A" --option "Option B"
```

Flags: `--question`, `--context` or `--context-file`, `--option` (2 to 4),
`--recommended`, `--image` (up to 4 PNG or JPEG files), `--link` (up to 4 HTTPS URLs),
`--answer-in`, `--waiting`, and `--agent codex` when Codex runs it (Claude
Code is detected). Or `--json card.json` with `question`, `context`, `options`,
`recommended`, `images`, `links`. It prints the
decision id, such as `d_Xk3…`, and adds this session's title and links on its
own.

## Never

- Ask the same question in two places: in the terminal and on a card, or on a
  card and in an artifact.
- Ask what you can decide yourself.
- Post several cards where one would do.
- Post a wall of text, or links for reference.
- Act on a question's behalf. No answer means you keep waiting; leave out
  `--default`.
- Block on an answer that comes back as a prompt: no `--wait`, no
  `starbridge wait`.

## Answers in an artifact

When you built a claude.ai artifact whose buttons send the pick to this
session, the user answers there. Post with `--answer-in <url>` and no
options. When its message arrives, run `starbridge settle <id>`, then act. An
artifact that is only to look at goes in `--link`, with the options on the
card. `starbridge settle <id> --outcome withdrawn` takes back a card you no
longer need, for example after the user answered in the terminal.

## After you post

Go on with the work that does not depend on the answer. When the answer
blocks you, work on something else, or, when both options are cheap to build,
build both and ask which result to keep. The rest depends on how the answer comes back.

After the card's id, `starbridge ask` prints how the answer comes back into
this session. Do what that line says.

**"The answer will come back into this session as a new prompt."** When only
the answer unblocks you, run `starbridge waiting <id>`: their devices show
"Waiting for you" and notify them once more. If you find more work before the
answer comes, run `starbridge working <id>`. Blocked from the start? Post with
`starbridge ask … --waiting`. Then end your turn, saying what waits on the
card. The answer arrives as a new prompt, possibly while you work on
something else:

```
Answer to d_Xk3… (Run the orders migration now, or after tonight's 18:00 backup?): Now
```

**"Nothing brings the answer into this session…"** Never end your turn with
this card open. When you have nothing left to do but the answer, wait for it:

```bash
starbridge wait d_Xk3… --timeout 5m
```

It marks the card "Waiting for you" and prints the answer in the same line as
above. Exit code 2 means 5 minutes passed with no answer: run the same
command again, as long as it takes.

Either way, act on the answer right away. Post again only when the outcome changes what the user
would do, for example when the merge failed or the fix needs their call.
Otherwise, say it in your final message.

## Report a run

Wrap a command in `starbridge run`, unasked, when it blocks the user or needs
them at the machine (e2e tests that take over the screen, keyboard or
session; anything holding a device they use), or when their instructions ask
you to report it, such as "tell me when you run local inference".

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
