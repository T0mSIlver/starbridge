# The card and answering

The card is a bottom sheet with the question, its rendered context (bold, code,
lists, links), the options with the first checked, "Your answer", and Snooze.
Tapping an option, or sending a typed answer, answers the question, and the
agent waiting on it gets the answer.

## Sub-features

- `context`: the Markdown renders ("Run the backfill tonight" appears).
- `options`: "Ship tonight" and "Wait".
- `reply`: a typed answer.
- `snooze`: not driven.

## How to get to it (user POV)

- Tapping the notification, or the question in the inbox.

## Driving it with android.ts

Preconditions: a notification shown (notification.md).

- Open it: `tap(QUESTION.slice(0, 30))`, then `see("Run the backfill tonight")`.
- Answer: run with `ANSWER="Ship tonight"`. The script taps the option, then the
  machine's CLI `wait <id> --timeout 30s` prints
  `Answer to d_… (<question>): Ship tonight` and exits 0; the inbox then shows
  "Nothing needs you" and History "1 answered today" (`answered.png`).

## Gotchas

- The CLI may print "could not mark it waiting … was already answered": it ran
  after the tap. Not a failure.
- The typed reply has no driver yet: `replace("Your answer", text)`, then the
  send button.
