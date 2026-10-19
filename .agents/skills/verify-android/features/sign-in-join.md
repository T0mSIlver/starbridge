# Sign-in and join

A first launch signs the app in to a server with an owner token and joins the
account as a new device: the owner approves it by comparing digits.

## Sub-features

- `server`: "Use your own server" and the server's address.
- `token`: the owner token field, then "Sign in".
- `digits`: "Compare digits", the owner's side approves, "They match".

## How to get to it (user POV)

- A fresh install's first screen. A scan of a pairing QR and a link are other
  entry points; this run doesn't drive them.

## Driving it with lib.ts

Preconditions: a demo server on `PORT`, and the demo owner device approving
joins (`DemoDevice.approveJoins`, which `android.ts` starts).

- `signInAndJoin(server, ownerToken)`: starts the activity, taps "Use your own
  server", `replace("Server", …)`, `replace("Owner token", …)`, BACK to close the
  keyboard, taps "Sign in", then "Can't scan? Compare digits" and "They match", and waits for
  "Inbox". Result: the steps `join by digits` and `approved <model> (digits …)`.

## Gotchas

- The token field hides what it got and a slow emulator drops keys: the helper
  types it again up to three times.
- The server's address is `http://127.0.0.1:<PORT>`, reached through `adb reverse`.
