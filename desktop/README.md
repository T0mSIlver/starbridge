# Starbridge desktop

The macOS app: the server's web page in a window, the Needs-you count in the menu bar, and a
notification per question that you answer with its buttons or a typed reply. The page stays the
device, as in a browser; the app adds what a browser cannot. SPEC.md, "Desktop", has the rules.

## Develop

From the repository root, after `pnpm install`:

```bash
pnpm --filter @starbridge/desktop exec install-electron
pnpm --filter @starbridge/desktop start
```

`STARBRIDGE_SERVER=http://localhost:3000` points a run at a local server; otherwise the app uses
the server set from its menu bar icon (right-click, "Server"), starbridge.run by default.

Tests: `pnpm test` (unit) and `pnpm e2e`, which launches the app on a stand-in page and checks the
bridge, the menu bar count and the notifications (`xvfb-run -a` on Linux). The `desktop` workflow
runs both on GitHub's macOS runner and keeps the DMGs.

`pnpm dist` packages the app on a Mac (`release/`). `node scripts/icons.ts` renders the icons.

## The bridge

The page finds `window.starbridgeDesktop` only on the configured server's origin:

- `version`: the app's version, which the page sends as `starbridge-client: desktop/<version>`.
- `update({count, entries})`: the Needs-you count and one entry per item to notify
  (`src/bridge.ts`). Send it whenever either changes.
- `onAnswer(f)`: `f({id, choice} | {id, text})` sends a notification's answer and rejects with
  the reason it was not sent.
- `onOpen(f)`: `f(id)` opens the item whose notification was clicked.

The main process checks that each message comes from the window's top frame on that origin, and
checks every field again.
