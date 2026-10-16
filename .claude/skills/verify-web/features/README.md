# Web features

| Feature | File | Scenario | CI's e2e part |
|---|---|---|---|
| Ask and answer | [ask-answer.md](ask-answer.md) | `ask-answer.ts` | inbox |
| Web Push | [push.md](push.md) | `push.ts` | inbox, devices |
| Pairing and sign-in | [pairing-sign-in.md](pairing-sign-in.md) | `sign-in-again.ts`, and every run's setup | every part, devices for the rest |
| Permission prompts | [permission-prompt.md](permission-prompt.md) | `permission-prompt.ts` | inbox (shown only) |

No feature file yet; CI's e2e covers them, and its steps in `web/e2e/run.ts`
show how to drive them: snooze (snooze part), quotas and quota alerts (inbox),
runs (inbox, devices), recovery key and account deletion (devices), landing
and docs pages (inbox).
