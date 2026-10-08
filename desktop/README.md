# Starbridge desktop

The macOS app: the server's web page in a window, an amber light in the menu bar while something
needs you, and a notification per question that you answer with its buttons or a typed reply. The
page stays the device, as in a browser; the app adds what a browser cannot. SPEC.md, "Desktop", has the rules.

## Develop

From the repository root, after `pnpm install`:

```bash
pnpm --filter @starbridge/desktop exec install-electron
pnpm --filter @starbridge/desktop start
```

`STARBRIDGE_SERVER=http://localhost:3000` points a run at a local server; otherwise the app uses
the server set from its menu bar icon (right-click, "Server"), starbridge.run by default.

Tests: `pnpm test` (unit) and `pnpm e2e`, which launches the app on a stand-in page and checks the
bridge, the menu bar icon and the notifications (`xvfb-run -a` on Linux). The `desktop` workflow
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

## Budgets

`test/perf.ts` measures the packaged app on GitHub's macOS runner and fails the `desktop`
workflow when one is blown. The window loads a stand-in page there, so the network is not in the
numbers.

| | Budget | 2026-10-09 |
|---|---|---|
| Cold start: process start to the window's first painted frame (median of 6 launches after a first) | 700 ms | 407–555 ms |
| Warm open: the hidden window to its next frame, as from the menu bar | 50 ms | 7–49 ms |
| Idle memory: every process's working set, page loaded | 350 MB | 304 MB |
| Download: the largest DMG | 140 MB | 133 MB |

What keeps them: the main process is one 15 KB file, the window shows at once on the page's
background colour, and closing it only hides it.
`STARBRIDGE_TIMING=1` prints the marks (`timing {...}`) from any build.

## The keychain

The page's cookies are encrypted with a key macOS keeps in the login keychain, "Starbridge Safe
Storage" (the `enableCookieEncryption` fuse). Only the app that made the key may read it without
asking. A Developer ID app stays that app through updates. Each ad hoc build is a stranger to it,
so macOS asks for the login password once per new ad hoc build; "Always Allow" covers that build.

## Signing

Pull requests build ad hoc signed apps: they open after "Open Anyway" in System Settings, and
their notifications show once allowed there (Electron 42 moved to `UNNotification`, which needs a
signed app; an ad hoc signature is enough, as the owner's Mac Mini showed). The Developer ID signs and notarizes in two places,
both through `scripts/sign.sh` and the `desktop-release` environment, which only `main` and tags
can use:

- the `desktop` workflow's `signed build` job, on `main` or run by hand, once the repository
  variable `DESKTOP_SIGNING` is `true`: a DMG to try;
- the release, once `DESKTOP_RELEASE` is `true` (SPEC.md, "The desktop app's release").

The environment's secrets: `MAC_CERTIFICATE` (the Developer ID Application certificate and key,
a base64 `.p12`), `MAC_CERTIFICATE_PASSWORD`, and an App Store Connect API key for notarization:
`APPLE_API_KEY` (the base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
