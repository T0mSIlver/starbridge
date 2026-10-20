# Pairing and sign-in

The owner signs in with GitHub (or Apple), sets up the first device by
creating keys and saving the recovery key, then pairs machines and other
devices by code: a machine's `starbridge pair` prints a code, the owner types
or scans it under Add a device and approves, and both sides compare a check
code. A browser that signs in again binds to its device without pairing.

## Sub-features

- `first-device`: the recovery key and the name on one screen, I stored this key, Create the account.
- `pair-machine`: `starbridge pair --name N`, Add a device, Check code,
  Approve, then `starbridge pair --confirm` on the machine.
- `pair-browser`: a second browser shows a code and QR; the first approves.
- `sign-in-again`: cleared cookies, GitHub sign-in, back on the inbox.
- `recover`: the recovery key on a new browser (devices part).

## How to get to it (user POV)

- The landing page's "Sign in with GitHub".
- The empty inbox's "Add a device"; Settings, Devices, Add a device.
- A pairing link `/pair#<code>` printed by `starbridge pair`.

## Driving it with drive.ts

Preconditions: none; drive.ts does `first-device` and `pair-machine` before
every scenario, and fails there if they break.

- Sign in again: `context.clearCookies()`, `page.goto(origin)`, click
  "Sign in with GitHub"; `getByText("Nothing needs you")` (`scenarios/sign-in-again.ts`).
- Still paired: a question from `devbox` opens on that browser.

## Gotchas

- The recovery key and pairing codes are random per run; CI's comparison
  masks them (web/e2e/volatile.ts).
- The machine's check code must match the page's: run.ts's `confirmCheck`
  compares them; drive.ts only confirms.
