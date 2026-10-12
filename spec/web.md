# Web

- **Security headers** (#312). Next sets a per-request nonce CSP in `web/src/proxy.ts`: scripts
  need the nonce or `'strict-dynamic'`, `'wasm-unsafe-eval'` lets libsodium compile, and an inline
  script sets Zod's `jitless`. Styles allow `'unsafe-inline'` (React style attributes), images
  `data:` and `blob:`, `frame-ancestors 'none'`. Every page renders per request, except the
  landing page below. Caddy adds HSTS, `nosniff` and `Referrer-Policy: same-origin`.
- **Tab switches wait on nothing** (#1072). Inbox, Quotas and Settings render on the client from
  the app's own data, so their links prefetch the whole page and keep it for an hour
  (`staleTimes.static`): a switch paints in one frame instead of a round trip to the server
  (80–150 ms at starbridge.run's 55 ms). A page of an older build reloads in full on its next
  navigation that reaches the server, and starbridge.run deploys many times a day; so a hidden page
  asks `/build` every 5 minutes and reloads onto a new build, unless a reply is typed for an open question (#1189), an answer
  is still being sent (#1167) or it is off the three tabs, where a reload would lose work.
- **Landing page HTML** (#694). A request for `/` without the session cookie gets the whole
  landing page from the server, with its own title, description and link preview
  (`public/og.png`), so link previews and crawlers see it and a first visit is never blank. The
  proxy renders it once per origin and serves that copy with a fresh nonce: Next's one thread
  filled near 18 visitors a second (#593), and a copy costs less than a render. With the cookie,
  `/` is the app as before; the page swaps to sign-in when the browser holds a device, after a
  failed sign-in, or on "Use your own server".
- **Landing: devices, then machines** (#1232). "Get the app" comes before the install box: a new
  user signs in on a device first (the first device shows the recovery key), then installs on each
  machine that runs agents. One card per device, three of equal size (Android, iPhone, Mac app) and
  no browser card, since the hero already signs in. Each card holds the platform, the minimum
  version a visitor could fail without, and the actions; no subtitles. Android has two buttons
  (the APK, Obtainium) and the Play testing links. No copy says "signed".
  The CLI never sits in a device card: a machine runs the agents, a device is where you answer.
- **Keyboard shortcuts** (#970) are written down once, in Settings → Inbox: J and K, 1 to 4, A
  and D from 1100 px, and / anywhere. Hints on the buttons and the Find box crowded the detail,
  and hints in some places but not others read as missing ones.
- **Back** (#347). Under 1100 px an open item is `/?item=<id>`, its own history entry, so Back
  returns to the list. Dialogs are modal `<dialog>`s, which Chrome on Android closes on Back.
- **Backoff** (#332). All calls in a page share one backoff, 250 ms doubling to 30 s with jitter,
  ended by any answer or the browser's online event. Pollers skip their turn while it waits.
- **The browser keeps the inbox** (Tom, 2026-10-12, #1380). A page load read every question from
  the start, the answered history with its images included: 18 MB and over a minute on an account
  with a long history, read twice since a poll started its own read before the first one ended.
  Now the browser keeps what the server listed in IndexedDB, still sealed to its device key and
  opened again on each load, and reads only what came after: its 500 latest answered questions
  and every open one, as the Android and iPhone apps keep 500. Each load first lists the open
  questions, so a kept one the server dropped goes, and an open one neither kept nor listed after
  the kept cursor means another or a reset server, which starts the read from scratch. Inbox
  reads run one at a time: a poll or a push during a read waits for it and starts from its
  cursor. Signing out, revocation and deleting the account forget what was kept. On a 500-question
  history (bench in #1380), a load went from 42 MB in 18 lists to 0.7 MB in 2.
- **Polling without push** (#664). Until a push reaches it, a visible page reads its inbox and
  open prompts every 5 s rather than 20 s, as Android does at 10 s (#445): it cannot tell a browser
  without Web Push from a server that sends none, and the owner may be watching it for a question.
  That is 24 reads a minute per visible page, inside the per-address limit; 100 such pages cost
  about a tenth of a core (#664 has the numbers). A hidden page still reads nothing, except in
  the desktop app, which notifies from its inbox and prompts and so reads them while hidden (#886).
- **Notifications.** The service worker shows one per question and closes it once answered. Its
  actions answer only for the account it was shown for (#274). Signing out, revocation or adopting
  new keys closes them all (#311).
- **Sound**: off by default. The page plays it when a push reaches it, since a service worker
  cannot play audio, so it needs an open page and this browser's notifications: while they are
  off the switch shows off, and turning it on asks for them first (#1061). A closed web app
  sounds as the system does.
- **Layout.** Panes resize by dragging or arrow keys. From an 840 px page, Quotas is one table and
  providers reorder by drag or keys; a group that "Running out first" pins shows a pin with a
  popover explaining why (#296, #351). The detail pane widens with the window (DESIGN.md `wide`).
- **Layout checks fail CI** (#305): every e2e screenshot at 390 and 1280 px, rechecked at 320,
  fails on overflow, clipped text without an ellipsis, overlapping text, or a CSP violation.
