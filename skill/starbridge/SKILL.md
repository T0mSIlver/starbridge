---
name: starbridge
description: "Ask the owner a decision through Starbridge: a notification on their phone and web page with the options as buttons, answered with one tap and sent back into this session. Use whenever you need the owner to decide something you should not decide alone, instead of asking in chat, where questions get buried. Covers when to ask, how to write a decision that stands alone on a lock screen, and how the answer comes back."
compatibility: The `starbridge` CLI on PATH, paired with `starbridge pair`.
---

# Ask the owner through Starbridge

The owner reads your decision on a lock screen, away from the code and busy
with something else. They see the question, the context and the options, and
they tap one. Write for that reader.

## When to ask

Ask only what is the owner's to decide:

- actions that are hard to undo, such as a force-push, deleting data, or
  publishing or sending something outside the machine;
- spending money or a scarce quota;
- scope: a feature, page or dependency nobody asked for;
- a choice between two reasonable designs where their taste decides.

Decide the rest yourself, act, and report what you did. A question you could
have answered costs the owner an interruption.

Never block on the answer. Post the decision, keep doing the work that does
not depend on it, and apply your default when its time comes.

## Write a decision that stands alone

| Field | Flag | Rule |
|---|---|---|
| question | `--question` | One sentence, at most 300 characters, ending in "?". Name the thing: "Merge #12 into main now?", not "Should I proceed?". |
| context | `--context` or `--context-file` | Why you ask, and what each option changes. Facts the owner cannot see from the phone: the PR, the error, the cost. Links are fine. Markdown code blocks render in monospace. |
| options | `--option`, 2 to 4 times | Short labels, at most 100 characters each, that differ at a glance. With no options, the owner types a free-text answer. |
| recommended | `--recommended` | The option you would pick. It shows first. Defaults to the first option, so list your pick first. |
| default | `--default` | What you will do if nobody answers. Required. |
| default time | `--default-at` | When you apply the default: `30m`, `2h`, or an ISO time. |

Checks before posting:

- Could the owner decide from the notification alone, without opening a
  terminal? If not, add what is missing to the context.
- Does the context say what each option changes? "Merge: ships tonight's
  release with the fix. Wait: the release goes out without it."
- Is the default something you will really do at that time?

Example:

```bash
starbridge ask \
  --question "Merge #12 (CLI uploader) into main now?" \
  --context "CI is green and the GLM review found nothing. Merge: the server PR can rebase on it today. Wait: I hold it until you have read the diff." \
  --option "Merge" --option "Wait for my review" \
  --default "Merge" --default-at 2h
```

It prints the decision id, such as `d_Xk3…`. Long context goes in a file:
`--context-file notes.md`, or `--json decision.json` with the fields
`question`, `context`, `options`, `recommended`, `default` and `defaultAt`.

## How the answer comes back

The answer is one line:

```
Answer to d_Xk3… (Merge #12 (CLI uploader) into main now?): Merge
```

- With the Starbridge mod in this Claude Code session, the mod submits that
  line to you as a new prompt. Post the decision and go on working.
- Without the mod, run `starbridge wait <id>` in the background (the Bash
  tool's `run_in_background`); you are notified when it exits. Or post with
  `starbridge ask … --wait`.

If you do not know whether the mod runs here, start the background wait
anyway. Act on the first answer and ignore a second copy.

`starbridge wait` exits 0 with the answer, and exits 2 when the default time
(or `--timeout`) passes with no answer. Then apply your default and say so in
your report. An answer that arrives later still counts: if the owner overrode
your default, undo what you can and tell them.

`starbridge wait` with no id prints the next answer to any decision from this
machine, which helps after a restart.
