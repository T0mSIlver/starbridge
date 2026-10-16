# The menu bar dot

An amber dot in the menu bar while something needs you. Its tooltip says how many:
`Starbridge: 1 needs you`, and `Starbridge` when nothing does.

## Sub-features

- `tooltip`: the text, recorded in the run (`g.tips`).
- `dot`: the icon's colour. Not shot on Linux: xvfb has no menu bar.

## How to get to it (user POV)

- The macOS menu bar. Closing the window leaves the app there.

## Driving it with stack.ts

Preconditions: a question asked (answering.md).

- `main(g => g.tips.at(-1) === "Starbridge: 1 needs you")` once the question is in;
  `=== "Starbridge"` after it is answered.

## Gotchas

- The icon itself is judged only on a Mac (`whole product on macOS`, or by hand):
  an agent that only has this run has not seen it. Say so in the verdict.
- `Tray.prototype.setToolTip` is replaced to record; the tray still exists.
