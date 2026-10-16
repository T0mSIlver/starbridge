# Desktop features

| Feature | File | Driven by |
|---|---|---|
| Sign-in and the first device | [sign-in.md](sign-in.md) | `stack.ts`, "sign in with GitHub" |
| Pairing a machine | [pairing.md](pairing.md) | `stack.ts`, "pair a machine" |
| Answering from a notification | [answering.md](answering.md) | `stack.ts`, the three question steps |
| The menu bar dot | [tray.md](tray.md) | `stack.ts`, tooltips only |

No feature file yet: the server window, updates, window and tab switching speed
(asserted in `stack.ts`), the quota views, and signing. `desktop/test/smoke.ts`
and `switch.ts` cover the launch and the switching.
