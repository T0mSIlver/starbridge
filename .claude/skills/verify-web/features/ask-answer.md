# Ask and answer

An agent runs `starbridge ask` with a question and options, and with `--wait`
blocks until the owner answers. The question shows in every signed-in
device's inbox; tapping an option or sending a typed reply answers it, and the
waiting command prints the answer.

## Sub-features

- `options`: two to four option buttons; the first is the default.
- `reply`: a typed answer in "Your answer", sent with Enter.
- `context`: Markdown under the question (`--context`), images (`--image`).
- `history`: the answered question moves to History.

## How to get to it (user POV)

- The inbox list: on a phone the card shows the option buttons; from 600 px
  the list opens the question in the detail pane on the right.
- A Web Push notification's actions (see push.md).
- A link to `/?item=<id>`, which opens it; a reload keeps it (#347).

## Driving it with drive.ts

Preconditions: none beyond drive.ts's setup.

- Agent asks: `machine("ask", ["ask", "--question", Q, "--option", "Run it", "--option", "Wait", "--wait"])`;
  `await ask.waitFor(/^d_\S+$/m)` is the decision id.
- Owner sees it: `page.getByText(Q).first().waitFor()`.
- Owner answers: open it (`getByText(Q).first().click()`), then
  `getByRole("button", { name: "Run it" })`.
- Session gets it: `ask.waitFor(/Answer to d_\S+ \(…\): Run it/)`, exit code 0.
- End state: the inbox says "Nothing needs you", History says 1 answered today.

## Gotchas

- With the question open, an option's accessible name gains " Default" on
  the first one, and the list row's button names the question too: select
  with an exact name or within the detail pane.
- `--option` needs 0 or 2 to 4 options; one is refused (`bad-schema`).
