---
name: starbridge
description: "Ask the owner a decision through Starbridge: a notification on their phone and web page with the options as buttons, answered with one tap and sent back into this session. Use whenever you need the owner to decide something you should not decide alone, instead of asking in chat, where questions get buried. Covers when to ask, how to write a decision that stands alone on a lock screen, and how the answer comes back."
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
| images | `--image`, up to 4 times | PNG or JPEG files the owner should see to decide: two mockups to compare, the failing screen, a chart. The CLI scales them down to fit. |
| links | `--link`, up to 4 times | HTTPS pages to open, such as a claude.ai artifact you built. For anything interactive, build an artifact and link it; the Claude app opens it on the phone. |

Checks before posting:

- Could the owner decide from the notification alone, without opening a
  terminal? If not, add what is missing to the context.
- Does the context say what each option changes? "Merge: ships tonight's
  release with the fix. Wait: the release goes out without it."
- Is the default something you will really do at that time?

Show rather than describe when the choice is visual: attach the screenshots
or mockups, one per option, in the order of the options, and say in the
context which image is which. An image costs the owner a glance; a paragraph
describing a layout costs them a guess.

Example:

```bash
starbridge ask \
  --question "Merge #12 (CLI uploader) into main now?" \
  --context "CI is green and the GLM review found nothing. Merge: the server PR can rebase on it today. Wait: I hold it until you have read the diff." \
  --option "Merge" --option "Wait for my review" \
  --default "Merge" --default-at 2h
```

With images and an artifact:

```bash
starbridge ask \
  --question "Ship the compact or the roomy settings screen?" \
  --context "First image: roomy, fits 6 rows and matches the inbox. Second: compact, fits 9. Try both in the artifact." \
  --option "Roomy" --option "Compact" \
  --image shots/roomy.png --image shots/compact.png \
  --link https://claude.ai/public/artifacts/0b3f0e7c \
  --default "Roomy" --default-at 4h
```

It prints the decision id, such as `d_Xk3…`. The CLI adds this session's
title and its Remote Control and Desktop links on its own, so the owner can
open the session from the decision; `--session-title` and `--session-link`
override them. Long context goes in a file:
`--context-file notes.md`, or `--json decision.json` with the fields
`question`, `context`, `options`, `recommended`, `default`, `defaultAt`,
`images` (file paths, or `{path, alt}`) and `links` (URLs, or `{url, title}`).

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
