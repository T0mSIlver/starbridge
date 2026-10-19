# Starbridge with T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) runs your Claude Code, Codex and Pi sessions in
its own app. Starbridge works there through the same plugins as in a terminal, so install it on
the machine that runs T3 Code's server, with `starbridge setup`. What follows was checked with
T3 Code 0.1.1 (nightly of 2026-10-18).

## What works in each harness

| | Claude Code | Codex | Pi |
|---|---|---|---|
| A question from `starbridge ask` reaches your devices | ✓ | ✓ | ✓ |
| Your answer comes back into the T3 thread | ✓ as the next turn | ✓ when the agent's wait ends | ✓ as the next turn |
| The question picker races T3's own question | ✓ | – | – |
| Permission prompts reach your devices | ✓ | ✓ once the hooks are trusted | not checked |

In T3 Code, opencode, Cursor and Antigravity are not checked.

### Claude Code

Your answer to a question comes back as the thread's next turn, which T3 Code shows as
"Background activity updated".

With `starbridge config permissions on`, a permission prompt shows in T3 Code and on your devices
at once. When you allow it on a device, the command runs, but T3 Code keeps its approval open and
the thread takes no message. Tap Approve or Decline in T3 Code to close it: the command does not
run again.

On Windows, answers to questions wait for `starbridge wait`, and the T3 thread shows Working
until you answer.

### Codex

Codex runs Starbridge's hooks only once you trust them, and T3 Code never asks. Trust them once,
in a terminal on the machine that runs T3 Code:

1. Run `codex` in any project.
2. At "Hooks need review", choose Trust all and continue.

Until then, permission prompts stay in T3 Code, and Codex starts sessions without Starbridge's
rules.

The agent waits for your answer with `starbridge wait`, which Codex moves to the background after
a few seconds, so the thread is free meanwhile. Once you answer, the wait ends and Codex starts a
turn with your answer.

A permission prompt goes to your devices first. T3 Code shows it only when your devices have not
answered it within 9.5 minutes, or at once while you are at the machine with
`starbridge config presence on`.

### Pi

Your answer to a question comes back as the thread's next turn. Permission prompts through
pi-permission-system are not checked in T3 Code.

## Avoid two notifications for one question

T3 Code pushes to its phone app when an agent needs approval or asks for input, so a question
reaches you twice: once from Starbridge, once from T3 Code. To get it once, turn off T3 Code's
push for the environments Starbridge covers:

1. In T3 Code, open Settings → Connections.
2. Under the environment, turn off Publish agent activity.

T3 Code then also stops telling you when an agent finishes or fails, which Starbridge does not do
for T3 threads. To keep those, leave it on and take both notifications.
