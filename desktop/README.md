# Starbridge desktop

The macOS app: the server's web page in a window, an amber light in the menu bar while something
needs you, and a notification per question that you answer with its buttons or a typed reply. The
page stays the device, as in a browser; the app adds what a browser cannot. spec/desktop.md has the rules.

## Develop

From the repository root, after `pnpm install`:

```bash
pnpm --filter @starbridge/desktop exec install-electron
pnpm --filter @starbridge/desktop start
```

`STARBRIDGE_SERVER=http://localhost:3000` points a run at a local server; otherwise the app uses
the server set from sign-in's "Use your own server", starbridge.run by default.
`STARBRIDGE_RELEASES` points the updater, which otherwise runs only in a packaged app, at another
repository's GitHub page or a stand-in for it. A packaged app reads neither, nor `STARBRIDGE_TIP`, so
another process cannot repoint it; `test/perf.ts` and `test/switch.ts` write the server into a
packaged run's `settings.json` instead.

Tests: `pnpm test` (unit) and `pnpm e2e`, which launches the app on a stand-in page and checks the
bridge, the menu bar icon, the notifications and an update from a stand-in release feed (`xvfb-run -a` on Linux). The `desktop` workflow
runs both on GitHub's macOS runner and keeps the DMGs. `test/stack.ts` runs the app on the whole
product (server, built web page, CLI, a stand-in GitHub): it signs in through the browser and
pairs in the app's window, times the switch between tabs, and answers `starbridge ask --wait`
from the notifications; CI's
`desktop end to end` job runs it (`xvfb-run -a node desktop/test/stack.ts` after `pnpm build`).

`pnpm dist` packages the app on a Mac (`release/`). `node scripts/icons.ts` renders the icons.

## The bridge

The page finds `window.starbridgeDesktop` only on the configured server's origin:

- `version`: the app's version, which the page sends as `starbridge-client: desktop/<version>`.
- `titleBar`: `"inset"` when the window has no title bar, and the page leaves room for its
  buttons.
- `update({count, waiting, account, entries})`: the Needs-you count, how many of them an agent
  waits on, `"ready"`, `"signedOut"` or `"loading"`, and one entry per item to notify
  (`src/bridge.ts`). Send it whenever any changes.
- `onAnswer(f)`: `f({id, choice} | {id, text})` sends a notification's answer and rejects with
  the reason it was not sent.
- `onOpen(f)`: `f(id)` opens the item whose notification was clicked.
- `place()` and `setPlace(p)`: where the app stays, `"menu"`, `"dock"` or `"both"` (from 0.1.3).
- `screen()`: the Mac's reading, `{away, idleMs}`: away while locked, asleep or quitting, and the
  milliseconds since its last input, null while asleep or quitting (`src/screen.ts`).
  `onScreen(f)`: `f()` runs every 10 s and when it changes; the app waits for its promise before
  it quits.
- `clock()`: `"12"` or `"24"`, the Mac's own choice (System Settings → General → Date & Time →
  24-hour time, else its region's), read again at each window focus (`src/clock.ts`).
- `shown()`: whether the window is on screen; `onShown(f)`: `f()` runs when it shows or hides.
- `notificationsBlocked()`: whether macOS refused the last notification, as it does while it
  blocks the app's; `onNotificationsBlocked(f)`: `f()` runs when that changes.
  `openNotificationSettings()` opens System Settings → Notifications → Starbridge and forgets
  the refusal until the next notification (#1069).
  The page's `document.visibilityState` stays "visible" in the app, which never throttles it.
- `updateStatus()`: where the update stands, `{state}` with `"idle"`, `"checking"`,
  `"available"`, `"downloading"`, `"ready"` or `"error"`, and its `version`, `percent` or
  `message` (`src/updates.ts`); null while the app runs no updater. `updateSettings()` and
  `setUpdateSettings(s)`: `{channel, autoDownload}` (`channel` is `"stable"`, `"rc"` or `"tip"`), any
  field; `updateSettings()` adds `ahead`, whether the installed version waits for the channel to
  pass it, `tip`, whether Tip is offered (on a tip build or while on Tip; the app refuses it otherwise), and `releaseCandidates`, the switch that pages from before the channel read and set (#1692). `updateAction(a)`:
  `"check"`, `"download"`, or `"install"`, which restarts the app. `onUpdate(f)`: `f()` runs when
  the status or the settings change (#1398).

The main process checks that each message comes from the window's top frame on that origin, and
checks every field again.

## The widget

`widgets/` holds the Needs you widget (#1031), a Swift package: `NeedsYou`, the WidgetKit
extension, and `Reload`, the helper the app runs to write `widgets.json` into the App Group
container and ask WidgetKit to redraw (`src/widgets.ts`). `scripts/widgets.cjs`, electron-builder's
afterPack hook, builds both with `widgets/build.sh` (`swift build`, Xcode's macOS SDK), copies them into the app
and signs them with their own entitlements; `scripts/check-widgets.sh` checks a packaged app.
The App Group needs the Team ID, so only a Developer ID build shows a count. A new widget build
registers once the app sits in /Applications and has run; `pluginkit -m -p
com.apple.widgetkit-extension -v` lists it.

## Budgets

`test/perf.ts` measures the packaged app on GitHub's macOS runner and fails the `desktop`
workflow when one is blown. The window loads a stand-in page there, so the network is not in the
numbers. The Mac Mini column is main 12df3fee on the owner's Mac Mini (2026-10-09), with the same
script: a real Mac uses more memory than the runner, so its budget is 400 MB, while CI gates at
350 MB (owner's call, keeping the updater's ~23 MB). The runner column spans 104 runs from
2026-10-08 to 10-11; a job on a slow runner takes about twice as long throughout, so the time budgets
sit just above the slowest run (#1119).

| | Budget | Runner | Mac Mini M2 |
|---|---|---|---|
| Cold start: process start to the window's first painted frame (median of 13 launches after a first) | 1000 ms | 272–982 ms, median 452 | 258–260 ms |
| Warm open: the hidden window to its next frame, as from the menu bar, timed in the page (median of 9) | 80 ms | 26–50 ms, median 39 (15 runs, 2026-10-20, #2136) | 15 ms |
| Idle memory: every process's working set, page loaded | 350 MB on the runner, 400 MB on a Mac | 304–310 MB | 371–378 MB |
| Download: the largest DMG | 140 MB | 133–134 MB | 134 MB |
| Tab switch: click to the frame painting the new page, warm, with no request for the page (`test/stack.ts`) | 100 ms | 29–33 ms | 26–40 ms, behind a 55 ms round trip; 80–97 ms before (#1072) |

What keeps them: the main process is one 15 KB file, the updater (most of the code) loads 5 s
after start from its own file, the window shows at once on the page's background colour, and
closing it only hides it. The tabs prefetch their pages and keep them an hour, so a switch never
waits on the server, and a hidden window loads a new deploy of the page, which otherwise reloads in
full on the next click (#1072). `node test/switch.ts` times the switch on the whole product behind
starbridge.run's round trip (`--rtt 55`), in Chromium (`--client chrome`), in an app on another
machine (`--cdp`), and across a deploy (`--deploy`).
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

- the `desktop` workflow's `tip build` job, once the repository variable `DESKTOP_SIGNING` is
  `true`: on every push to `main` that touches the app, or run by hand from `main`. Its build is
  published to [starbridge-tip](https://github.com/T0mSIlver/starbridge-tip) (spec/releases.md,
  "Three rings"), with a fine-grained token that writes that repository only,
  `TIP_RELEASE_TOKEN`; without it the build is signed and kept as an artifact, not published;
- the release, once `DESKTOP_RELEASE` is `true` (spec/releases.md, "The desktop app's release").

The environment's secrets: `MAC_CERTIFICATE` (the Developer ID Application certificate and key,
a base64 `.p12`), `MAC_CERTIFICATE_PASSWORD`, and an App Store Connect API key for notarization:
`APPLE_API_KEY` (the base64 `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`; and `TIP_RELEASE_TOKEN`.
