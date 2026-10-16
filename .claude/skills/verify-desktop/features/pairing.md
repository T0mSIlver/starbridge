# Pairing a machine

`starbridge pair` on a machine prints a pairing code; the owner enters it in the
app's Add a device page, approves, and reads the check code, which the machine's
terminal shows as well; `pair --confirm` answers its question.

## Sub-features

- `code`: "Pair a machine or device", "Check code", "Approve".
- `check`: the window's `check-code` test id shows `Check code <code>`.
- `confirm`: the machine says `✓ Paired as <name>`.

## How to get to it (user POV)

- Settings, "Add a device"; the empty inbox's "Add a machine".

## Driving it with stack.ts

Preconditions: signed in, the first device set up.

- Machine: `cli("pair", ["pair", "--name", "devbox"], home)`; `waitFor(/Pairing code: (\S+)/)`.
- Window: Settings, "Add a device", `getByLabel("Pair a machine or device").fill(code)`,
  "Check code", "Approve".
- Result: `pair.waitFor(/Check code: (\S+)/)` equals the window's check code;
  `pair --confirm` exits 0; `pair.waitFor(/✓ Paired as devbox/)`.

## Gotchas

- The check code and pairing code change each run: the evidence masks them
  (`check-code`, `pairing-code` test ids).
- Each machine needs its own config dir (`STARBRIDGE_CONFIG_DIR`).
