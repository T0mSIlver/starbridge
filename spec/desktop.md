# Desktop

The macOS app (#886) is Electron around the configured server's web page (starbridge.run unless
the owner sets another in Settings). The page signs in, pairs and keeps its keys as in
a browser; the app adds a menu bar light and notifications, so a web release needs no app release.

- **The bridge.** The app's preload gives `window.starbridgeDesktop` to the server's origin only,
  and the main process answers only the window's top frame on that origin. It carries data, never
  code or a URL to open: the page sends the Needs-you count and the items to notify; the app sends
  back a notification's answer and the item to open. Every field is checked on arrival, since the
  page comes from a server. Only the server's pages stay inside the window; any other link opens
  in the browser, and new windows never open.
- **Sign-in** goes through the owner's browser, as on Android: the browser is signed in to GitHub
  and holds the owner's passkeys, which the app's window cannot use (Electron sees only passkeys
  it made itself). Sign in with GitHub opens the browser with a PKCE challenge; the code comes back
  on `starbridge://auth`, and the app trades it with its verifier for the session, which becomes
  the page's session cookie. Owner-token sign-in stays in the page.
- **Signed out**, the app opens on sign-in, never on the landing page: the app sets an
  `sb_desktop` cookie, which the server's landing and the page both read. Sign-in offers GitHub,
  and "Use your own server" opens the app's server window rather than the page's owner-token
  form, since the app restarts on a new server (#1449); a server without GitHub shows its
  owner-token form. Setup says "this app" and suggests the name "Starbridge on Mac" (owner's pick
  from mockups, #905).
- **Notifications.** One per item in Needs you, as on the phone: a question's options are its
  buttons, and a question that takes typed answers has Reply. An answer goes through the page, as
  if tapped there; when it fails, an "Answer not sent" notification says why. An item notifies
  again when its agent starts waiting or it comes back from snooze, and its notification closes
  when it leaves Needs you, wherever it was answered. Items already notified stay quiet across a
  restart. Items notify through the app, never through the browser's notifications; quota
  alerts stay the page's own, which the app shows as it would a browser's. Settings →
  Notifications turns them off and on (#943).
- **Sound** (#1055). Questions and prompts play macOS's default sound, the tone the owner set,
  as most Mac apps do. "Answer not sent" plays Basso, macOS's error sound: it can come seconds
  after the tap, once the owner looked away, and an agent still waits. Quota alerts are silent,
  heads-ups as on Android. Custom sounds were left out: they would override the owner's tone
  and are design work for little gain. macOS plays a sound at System Settings → Sound → Alert
  volume, on the output under "Play sound effects through", both apart from what plays
  everything else; the owner heard nothing with Alert volume at zero. The web's chime plays on a
  Web Push, which the app never gets, so its Settings show no Sound row.
- **Notification permission** (#935). Electron asks macOS when it first needs notifications, and a
  question shown while macOS still asks reaches only the window. So the app asks once the page
  has a session, after one line saying why, and a notification macOS refused shows again with
  the page's next update (every 15 s), so it appears once the owner allows them.
- **Blocked by macOS** (#1069). Electron 44 cannot read whether macOS allows the app's
  notifications, but macOS refuses each one while it blocks them, and Electron reports it. After
  a refusal, Settings → Notifications shows the switch off with "Blocked by macOS: allow
  Starbridge in System Settings → Notifications", and turning it on opens that page
  (`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=<bundle id>`). A
  refusal within 5 s of turning the switch on opens it too, since the switch's first
  notifications are what find the block. Opening it forgets the refusal until the next
  notification, which then shows or flips the switch back. Devices reports such a Mac as blocked.
- **The menu bar.** The mark in one colour, as macOS draws menu bar icons; while anything needs
  the owner, its dot turns amber, the one amber light, with no count: the window says what
  (owner's pick from mockups, 2026-10-09). A click shows the window, nothing else; a right-click
  opens Open Starbridge, Settings… and Quit, so the app quits with its window closed (#1449). Open
  at Login moved to Settings → App, desktop only, with Keep Starbridge in (from Look), as Open
  Starbridge at login (off by default). The server has no Settings row: it is chosen at sign-in, as
  on the web, so the default is hard to leave by mistake (owner's call). Settings… opens the
  server window instead while the page can't load, so a wrong server can still be fixed. Closing the
  window keeps the app in the menu bar and drops its Dock icon, which shows again with the window.
  ⌃⌥S shows the window from anywhere.
- **The menu bar icon** centres the arch top to bottom in its 18 pt image, as the system icons
  are (#1449): standing on the image's bottom edge, as the other crops do, it sat 1.5 pt below them.
- **The amber icon's arch follows the menu bar, not the theme** (#1514). macOS tints the bar by the
  wallpaper, so a light-theme Mac can have a dark bar with white icons, and the plain mark (a
  template image) follows it while the amber one, which carries its colours, did not. While
  something needs the owner, a JXA probe (`osascript`, no install) reads a status item's
  appearance and the icon switches between a light and a dark variant live; until it answers, or
  if it can't run, the theme decides.
- **Updates** (#1398) live in the window, not the menus, as in T3 Code: a menu item went unseen,
  so a downloaded update waited for a quit. At the foot of the rail, a button says "Update
  available" (a click downloads), "Downloading 42%", "Restart to update" (a click quits, after
  the page says the owner left, and installs), or "Update failed" (a click checks again), the first
  and third with a dot in `fg`, never amber, which means an agent needs the owner. It shows
  nothing while idle or checking, and a failed check only logs: it may be the network, and the
  next one comes. Checks go on while an update is offered or downloaded, and a newer release
  replaces it, so one click installs the newest (#1444). Settings → Updates holds "Update channel", Stable, Release candidates or Tip
  (#1692, which replaced the "Release candidates" switch, the menu's former "Get Release
  Candidates"; spec/releases.md), and "Download updates automatically" (on). The bridge carries the
  updater's state and three actions, check, download and restart, so the page decides nothing
  about versions. A browser sees none of it, the one place the app's page differs from the
  browser's besides "Keep Starbridge in". Under 600 px the rail gives way to the bottom bar, and
  the button with it: an update still installs on quit.
- **The Dock badge** (#1602). While the Dock icon shows, it carries the Needs-you count as a number
  (macOS's own, as in WhatsApp or Discord), cleared at 0 and on sign-out. It is the widget's count
  (#1031): open questions and permission prompts, snoozed ones out until they return. The menu bar
  icon stays a light with no count, since the Dock is where a number is expected. No Settings
  row: macOS's Notifications → Badges for the app turns it off.
- **Menu bar or Dock** (#936). Settings' "Keep Starbridge in" picks the menu bar (the default
  above), the Dock (always, with no menu bar icon), or both, applied at once. One choice of three
  rather than two switches, so no combination leaves the app nowhere and nothing has to be
  greyed out. The Dock icon's menu holds Settings…, for when there is no menu bar icon.
- **The window** has no title bar on macOS (owner's pick from mockups, #938): the page's rail
  already names the app and the page, and counts what needs the owner. The rail runs to the
  window's top in its own colour, the window's buttons sit in its first row before the app's name,
  and the panes beside it start at the top (owner's pick from mockups, #1006): a band in the page's
  background across the whole window ran past the rail, and cost every pane 28 px. A see-through
  52 px strip across the top, macOS's toolbar height, drags the window. Pages without the rail
  (sign-in, docs) leave that strip empty in the page's background; under 600 px it takes the top
  bar's colour. The window keeps the name "Starbridge" for Mission Control and
  the Window menu, whatever the page's title. Under the page, the window shows the page's last
  background, else the system theme's (#1072): a fixed dark one flashed black in light mode
  whenever the page reloaded.
- **Presence** (#945). The window in use holds pushes as a web page does (#848). Hidden, it said
  absent while the owner worked in another app, so the phone buzzed at a desk. Electron's
  `powerMonitor` reads what the CLI's machine presence reads: lock, sleep and wake, and the
  seconds since the Mac's last input. The app hands the page that reading over the bridge, and
  the page's own beacon sends the one bit (`isPresent`, the CLI's threshold): present while the
  Mac is unlocked with input in the last minute, window shown or not. Locked, asleep or quitting,
  the page says absent at once, and the app waits up to 2 s on quit for the page to say so. Any
  app on the Mac counts, with no switch of its own (#1003): the owner found two "Hold" rows read
  as two holds, and with the switch off the window still counted while touched, so a Mac in
  another app held a push one time and not the next. The hold time is the opt-in: Off, nothing
  is held, whatever presence says.
- **The Needs you widget** (#1031), in Notification Center and on the desktop: Android's 2×2
  (#894) at WidgetKit's small size, the same count and amber. The owner left out Quotas widgets,
  which CodexBar's own widgets already show. A WidgetKit extension in `Contents/PlugIns` draws it;
  the page sends the count and how many of them an agent waits on over the bridge, and the app
  writes them into the App Group `3N63N7U9R3.dev.starbridge` through a small Swift helper, which
  also asks WidgetKit to redraw (WidgetCenter is Swift only). The widget reads that file and
  nothing else: fetching the server itself would need a token in a shared keychain group, which
  takes a provisioning profile, and the device's keys. It redraws on each change, as Android's
  does, and every 30 minutes; quitting, the app says Starbridge is closed rather than leave a
  count nobody updates. A click opens the Inbox (`starbridge://inbox`). The group carries the
  Team ID because from macOS 15 that is what lets an app outside the App Store open it without
  asking, so ad hoc builds (pull requests) show "Starbridge is closed": macOS refuses them the
  group.
