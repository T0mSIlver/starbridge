---
name: starbridge
description: "Ask the owner a decision through Starbridge, and report the commands their rules name. A decision is a notification on their phone and web page with the options as buttons, answered with one tap and sent back into this session; use it whenever you need the owner to decide something you should not decide alone, instead of asking in chat, where questions get buried. A run wraps a command in `starbridge run` so their phone shows it running, its progress, then pass or fail; use it whenever a command matches one of the owner's rules for runs in your context. Covers when to ask, how to write a decision that stands alone on a lock screen, how the answer comes back, and how to wrap a run."
compatibility: The `starbridge` CLI on PATH, paired with `starbridge pair`, and the Starbridge mod loaded in this Claude Code session.
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

## Write a decision that stands alone

| Field | Flag | Rule |
|---|---|---|
| question | `--question` | One sentence, at most 300 characters, ending in "?". Name the thing: "Merge #12 into main now?", not "Should I proceed?". |
| context | `--context` or `--context-file` | Why you ask, and what each option changes. Facts the owner cannot see from the phone: the PR, the error, the cost. Links are fine. Markdown code blocks render in monospace. |
| options | `--option`, 2 to 4 times | Short labels, at most 100 characters each, that differ at a glance. With no options, the owner types a free-text answer. |
| recommended | `--recommended` | The option you would pick. It shows first. Defaults to the first option, so list your pick first. |
| default | `--default` | What you will do if nobody answers. Required. |
| default time | `--default-at` | When you apply the default: `30m`, `2h`, or an ISO time. Always set it. |

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

It prints the decision id, such as `d_Xk3…`. The CLI adds this session's
title and its Remote Control and Desktop links on its own, so the owner can
open the session from the decision; `--session-title` and `--link` override
them. Long context goes in a file:
`--context-file notes.md`, or `--json decision.json` with the fields
`question`, `context`, `options`, `recommended`, `default` and `defaultAt`.

## After you post: keep working

Never wait for the answer. Do not pass `--wait` to `ask`, and do not run
`starbridge wait`, not even in the background. The owner may answer in a
minute or in three hours.

1. Go on with the work that does not depend on the answer.
2. When only that work is left, end your turn. Report what you did, what
   waits on the decision, and what you will do at the default time.
3. The Starbridge mod submits the answer into this session as a new prompt:

   ```
   Answer to d_Xk3… (Merge #12 (CLI uploader) into main now?): Merge
   ```

   It may arrive while you are busy with something else. Finish the step you
   are on, then act on the answer.
4. If nobody answers by the default time, the mod submits:

   ```
   No answer to d_Xk3… (Merge #12 (CLI uploader) into main now?) by its default time 2026-10-04T18:00:00Z: apply your default: Merge
   ```

   Apply the default then, and say so in your report. If you are still
   working when the default time passes, apply it without waiting for that
   prompt.

An answer can still come after you applied the default. If the owner chose
something else, undo what you can and tell them.

## Report a run the owner asked about

The owner's rules for runs, if they wrote any, are in your context under
"My rules for runs", in plain words, such as "tell me when you run e2e tests
that take over my Mac, or local inference". When a command you are about to
run matches one, wrap it in `starbridge run`. Their phone then shows the
title, the reason, the time elapsed and any progress the output prints, then
pass or fail.

```bash
starbridge run --title "Mac e2e" --reason "uses your session and keyboard" \
  -- bash -c 'make build && make e2e'
```

- Wrap the whole command, chained or not: `-- bash -c '...'` around
  `a && b; c`, never one part of it. The owner wants to know when the
  machine is busy and when it is free again.
- `--title`: what it is in a few words, at most 100 characters.
- `--reason`: always. Why the owner hears of it, from their rule, at most
  200 characters: "uses your session and keyboard", "loads the GPU".
- Nothing else changes. The output passes through unchanged, and the exit
  code is the command's own, so read both as usual. Progress lines such as
  `[3/7]` or `42%` reach the phone on their own; there is nothing to add.
- When no rule matches, run the command as usual. Do not wrap commands the
  rules do not name.

## Permission prompts may be answered from a phone

When the owner turned on `starbridge permissions`, your permission prompts
also go to their phone, which shows the tool and a one-line summary. Give
every risky Bash command a `description` that says what it does and why: it
is what the owner reads before allowing it.
