# Answering from a notification

Each question notifies with its options as buttons, or a reply field when it has
none. A button or a typed reply answers it, and the waiting `ask --wait` prints the
answer. A question answered in the window closes its notification.

## Sub-features

- `buttons`: the option buttons, in order.
- `reply`: a typed reply for a question without options.
- `close`: the window's answer closes the notification.

## How to get to it (user POV)

- The system notification; the window's inbox.

## Driving it with stack.ts

Preconditions: a machine paired as `devbox`.

- Ask: `cli("ask", ["ask", "--question", Q, "--wait", "--option", "Ship it", "--option", "Wait"], home)`.
- Notification: `main(g => g.shown.find(n => n.title === Q))` has `actions`
  `["Ship it", "Wait"]`.
- Button: `n.emit("action", { actionIndex: 1 }, 1)`; the CLI prints
  `Answer to d_… (Q): Wait` and exits 0. Hide the window first to prove it works
  from the menu bar (`BrowserWindow.getAllWindows()[0].hide()`).
- Typed: `n.emit("reply", { reply: "text" }, "text")` on a question without options.
- Window: click `getByRole("button", { name: /^Merge/ }).first()`; `g.closed`
  then holds the notification's id.

## Gotchas

- Notifications are recorded by replacing `Notification.prototype.show`, not by
  the OS: a real macOS notification's look and delivery are not proven here.
- The first option's accessible name carries "Default" in the window.
