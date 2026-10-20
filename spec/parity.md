# Parity

Which client has each feature a user sees. A cell is `yes`, `no` with why, `n/a`, or `not yet`;
an issue number points at the work. What a feature does is in its area's file; this table says
only where it exists. A PR that adds or changes a feature in one client updates its row, and
opens an issue for each client the row says should follow. Every PR that changes a client's
source says so on its `Parity:` line, which CI requires: `spec/parity.md`, the follow-up issues, or
`none` and why (#1422). A rule every client applies on its own (snooze times, option order,
presence, retry, limits) lives in `packages/protocol/vectors/rules.json`, which the web's,
Android's and iOS's tests read, so a change to one fails the others until they follow (#1429).

| Feature | Web | Android | Desktop | iOS |
|---|---|---|---|---|
| Inbox order (runs, prompts, waiting, rest; group by machine / waiting) | yes | yes | yes | yes (#1131: one feed, by machine or by waiting, remembered on the iPhone) |
| Question card and answer buttons (setting: Always / When the agent waits / Never, under 1100 px) | yes | yes | yes | yes (#1131; the setting in Settings, #1233) |
| Selectable text (the question on its card; question, context, answer, prompt input in the detail) | yes (#1143) | yes (#1143) | yes (as web) | yes (#1143; a long press offers Copy) |
| Typed reply (field under the options, Enter sends) | yes | yes | yes | yes (#1122: field in the detail, the arrow sends; Return starts a new line) |
| Drafts | yes (until the page reloads) | yes (survives rotation and process death) | yes (as web) | yes (#1122: until the app quits) |
| Snooze | yes | yes | yes | yes (#1131: in the detail, times in place under Snooze; the time in the system picker) |
| Snooze button (#1848: a round tonal icon button at the end of the session's line, the session's name as grey text before it) | yes (a clock from the web's icon set) | yes (Material Symbols Rounded) | yes (the web's clock) | yes (an SF Symbol) |
| Swipe to snooze | no (Android gesture; web has the Snooze control only) | yes (#692) | no (as web) | yes (#1236: Undo in a bar at the bottom, as Android's snackbar) |
| History | yes | yes | yes | yes (#1122: answered questions, with how; prompts not listed) |
| Find | yes (rail box) | yes (Material 3 search view) | yes | yes (#1131: the system search field) |
| Permission prompts, answer from the device (Allow / Deny) | yes | yes | yes | yes (#1122: Allow, Deny with a note, offered scopes) |
| Runs (section, progress, dismiss) | yes | yes | yes | yes (#1122; the section #1170) |
| Link chips (icon and text from `linkChip`, packages/protocol) | yes (#971, #1577) | yes (#971, #1590) | yes (as web) | yes (#1591) |
| Quotas tab | yes | yes | yes | yes (#1234: read with the inbox every 10 s while the app is open, since APNs carries no snapshots; Order is a page under Settings → Quotas) |
| Quota alerts per window (settings) | yes | yes | yes | yes (#1235: Settings → Quotas → Alerts, a page like Android's; a section per window with a Toggle per alert, not a checkbox grid, #1859) |
| Widgets | n/a | yes (#894: Needs you, Quotas) | yes (#1031: Needs you only; no Quotas widget by owner's choice) | not yet |
| Notification: questions | yes (Web Push) | yes | yes | yes (#1137: a service extension opens the sealed box in place of the server's placeholder; delivery on a device waits for TestFlight) |
| Notification: permission prompts | yes (taps open the page; no Allow/Deny) | yes (Allow / Deny buttons) | yes (no Allow/Deny; opens window) | yes (#1137: Deny answers from the notification; Allow opens the prompt, which shows the whole input first) |
| Notification: runs | yes (#1064: pass or fail, while a page is open; runs skip Web Push) | yes (Live Update on Android 16) | yes (#1064: pass or fail, the page's own, shown by the app) | no (APNs gets no runs, as Web Push) |
| Notification: quota alerts | yes (only while a page is open) | yes (low-importance channel) | yes (the page's own, shown by the app) | yes (#1235: only when the app reads quotas, while it is open or woken by another push, since APNs gets no quota snapshots; quiet, in Notification Center) |
| Answer from a notification: option buttons (the notification goes at the tap, back only on a refusal, #1447) | yes (only if every option fits the browser's action limit) | yes (at most 3 options; 2 when the question also takes replies, #1339) | yes | yes (#1137: at most 3, the agent's default first, with Reply beside them) |
| Answer from a notification: typed reply | no (service worker has no input action) | yes (RemoteInput: Answer without options, Reply beside them, #1339) | yes (Reply button) | yes (#1137: Reply, or Answer for a question without options) |
| Answer a question from the lock screen | n/a (the browser's notifications) | yes while the lock screen shows sensitive content, else after the unlock (#1375) | n/a (macOS's notifications) | yes while Show Previews is Always, else after the unlock (#1384) |
| Presence (holds other devices' pushes) | yes (#848) | yes (#848) | yes (#945, uses Mac lock/idle) | yes (#1241: in front and touched or typed in the last minute; the hold time in Settings → Notifications) |
| Offline outbox / no answer lost | no (retries 502/503 for 20 s; unsent answer kept in page memory only) | yes (#329, #331: sealed, stored, sent by WorkManager) | no (as web) | yes (#1122, #1137: sealed and stored; sent from a notification in the time iOS gives it; #1392: retried on its own after a rate-limit hold, and by a background refresh behind the app) |
| Update screen / update notice | yes (426 shows a reload-only screen) | yes (#497: "Update Starbridge" screen) | yes (auto-updater from GitHub Releases; 426 as web) | yes (#1122: 426 shows "Update Starbridge"; answers stay in the outbox) |
| Recovery key: copy / save | yes (Copy the key; "I stored this key", #2139) | yes (copy to clipboard, #817; save) | yes (as web) | yes at first-device setup (#1116: Copy, clearing after a minute, and "I stored this key"; no Save, since iOS lets no app add a password to the password manager); Replace in Devices (#1240), with the same Copy |
| Devices list (notifies state, app icon, Revoke) | yes | yes | yes | yes (#1238: Settings → Devices and machines) |
| Inbox with no machine (install command, then pair it from there) | yes (#610; open the link setup prints, or Type a code instead, #1367, #2140) | yes (#610; Scan a QR code and Type a code instead, #1367, #2140) | yes (as web) | yes (#1370; Scan a QR code and Type a code instead, as Android) |
| Pairing: show QR for a new phone | yes | yes | yes | yes (#1239) |
| Pairing: scan a QR | no (no scanner in web) | yes (Play services code scanner) | no (as web) | yes (VisionKit: to join this iPhone, #1105; a machine's or another device's code in Devices, with the check key, #1239) |
| Pairing: link (`/pair#code`) | yes | yes (App Link) | no (the link opens the web page in the browser; the `starbridge://pair` link of CLIs before 0.1.1 is gone, #1628) | not yet (the link opens the web page until the app claims it, #1115; the `starbridge://pair` link of CLIs before 0.1.1 is gone, #1628) |
| Pairing: typed code | yes | yes | yes | yes (#1239) |
| Pairing: approve a join by digits (Compare digits) | yes | yes | yes (as web) | yes (#1158: over any screen while the app is in front; the notification opens the app) |
| After an answer, the next open card opens | yes (beside the list; under 1100 px only with a mouse, #1432) | no (touch: the inbox comes back) | yes (as web) | no (touch, as Android) |
| The open card settled elsewhere, the last one: the empty inbox comes back | yes (under 1100 px, #1583) | yes (#1586: the sheet closes) | yes (as web) | yes (#1587: the sheet closes) |
| App icon badge with the Needs-you count | no | n/a (launcher dot follows notifications, drawn by the system) | yes (#1602: Dock icon while shown; macOS Badges setting) | yes (#1603: from the extension while the app is closed; a card closed elsewhere lowers it only when iOS wakes the app for its push, never after the owner swiped the app away, until it opens; Badges setting) |
| Time format default (12 or 24 hours; Clock setting overrides) | yes (follows the browser's language; row says "Browser", #1705) | yes (follows the phone's 12/24-hour switch) | yes (follows macOS's switch; row says "System", #1705) | yes (follows the phone's 24-Hour Time switch; no Clock setting) |
| Keyboard shortcuts (J K 1-4 A D / ?) | yes (a dialog from Settings or `?`, #1889; J, K and / at any width, #1432; 1-4, A, D from 1100 px) | no (only Enter to send, Esc in Find) | yes (as web) | not yet |
| Sound | yes (off by default, only while a page is open) | yes (system notification channel sound) | yes (macOS default sound; Basso on "Answer not sent"; web Sound row hidden) | not yet |
| Removed on a chain a machine's head shows cut short: hold, keeping the keys, rather than wipe (#1779) | yes (a page that names the machine; Stop waiting when that machine is revoked) | yes (the hold notice, as for items) | yes (as web) | yes (the inbox's hold banner, as for items) |
| Sign out and Delete account forget what the account left beyond its keys: delivered notifications, quota settings and the alert history | yes (#2014: the account's localStorage keys; notifications closed; the display prefs stay) | yes (#2035: notifications cancelled, quota settings and shown alerts cleared; the display prefs stay) | yes (as web) | yes (#2013: delivered notifications, pending requests, categories, quota settings and shown alerts, badge) |
| Recover with the recovery key (revokes every other member) | yes | yes | yes (as web) | yes (#1116) |
| Sign in with Apple (no name or email asked) | yes (#1411: under Other ways to sign in; #1858: Apple's logo on a black or white pill) | yes (#1411: under Other ways to sign in; #1858: Apple's logo on a black or white pill) | yes (as web, in the browser) | yes (#1411: under GitHub's, the same size) |
| One wording for sign-in and the inbox's group-by control (#1860, owner's pick, card d_sauce-gain-payment): sign-in buttons say "Sign in with GitHub" and "Sign in with Apple"; the control is an icon button named "Group by" (its accessible label, and its tooltip or long press where there is one), never a text label | yes (was "Continue with" and "View") | yes (the sign-in already; the filter icon is named "Group by", was "View") | yes (as web) | yes (the sign-in already; the ellipsis icon and its picker are named "Group by", were "Options" and "View") |
| On a demo server, Add this phone says how to join (#2089) | n/a (the demo serves no web page) | yes | n/a (as web) | yes |
| Owner-token sign-in: the keyboard's key signs in, a failure stays under the fields (#2084) | yes (a form; its error stays under it) | yes | n/a (sets its server in its own window) | yes (#2085: return on the token field signs in, the alert waits while signed out) |
| Delete account (Settings and the join screen, its recovery-key view included, typed confirmation) | yes (#1104, #1117) | yes (#1104, #1117, #1166) | yes (as web) | yes (#1141, #1195, #1233: Settings and the join screen, its recovery-key view included) |
| App switcher or recents shows no snapshot of the app (#2197) | n/a (no switcher snapshot of its own) | yes (Android 13 and later; Android 12 keeps the thumbnail) | n/a (as web) | yes (a cover while the app is in the background) |
| Version row at the end of Settings → Account, the build's version right-aligned, a tap or click copies it and the value reads "Copied" for 1.5 s (#1892, owner's pick, card d_suffer-tip-symptom: a row, not a footer; it is the string the bug form's Version field asks for) | yes (the page's build version) | yes (`BuildConfig.VERSION_NAME`) | yes (the app's own version, not the page's) | yes (`CFBundleShortVersionString`) |

Only on desktop: the Mac menus (application menu, right-click; #1857), the menu bar light, Settings → App (the Dock or menu bar choice, Open Starbridge at login; #1449), ⌃⌥S, notifications while no browser runs, and the app's updates (the rail's button and Settings → Updates, #1398, with its channel, #1692; Tip only on a tip build, which the owner installs).
