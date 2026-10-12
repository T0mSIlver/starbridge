# Parity

Which client has each feature a user sees. A cell is `yes`, `no` with why, `n/a`, or `not yet`;
an issue number points at the work. What a feature does is in its area's file; this table says
only where it exists. A PR that adds or changes a feature in one client updates its row, and
opens an issue for each client the row says should follow.

| Feature | Web | Android | Desktop | iOS |
|---|---|---|---|---|
| Inbox order (runs, prompts, waiting, rest; group by machine / waiting) | yes | yes | yes | yes (#1131: one feed, by machine or by waiting, remembered on the iPhone) |
| Question card and answer buttons (setting: Always / When the agent waits / Never, under 1100 px) | yes | yes | yes | yes (#1131; the setting in Settings, #1233) |
| Selectable text (the question on its card; question, context, answer, prompt input in the detail) | yes (#1143) | yes (#1143) | yes (as web) | yes (#1143; a long press offers Copy) |
| Typed reply (field under the options, Enter sends) | yes | yes | yes | yes (#1122: field in the detail, the arrow sends; Return starts a new line) |
| Drafts | yes (until the page reloads) | yes (survives rotation and process death) | yes (as web) | yes (#1122: until the app quits) |
| Snooze | yes | yes | yes | yes (#1131: in the detail, times in place under Snooze; the time in the system picker) |
| Swipe to snooze | no (Android gesture; web has the Snooze control only) | yes (#692) | no (as web) | yes (#1236: Undo in a bar at the bottom, as Android's snackbar) |
| History | yes | yes | yes | yes (#1122: answered questions, with how; prompts not listed) |
| Find | yes (rail box) | yes (Material 3 search view) | yes | yes (#1131: the system search field) |
| Permission prompts, answer from the device (Allow / Deny) | yes | yes | yes | yes (#1122: Allow, Deny with a note, offered scopes) |
| Runs (section, progress, dismiss) | yes | yes | yes | yes (#1122; the section #1170) |
| Quotas tab | yes | yes | yes | yes (#1234: read with the inbox every 10 s while the app is open, since APNs carries no snapshots; Order is a page under Settings → Quotas) |
| Quota alerts per window (settings) | yes | yes | yes | yes (#1235: Settings → Quotas → Alerts, as Android's page) |
| Widgets | n/a | yes (#894: Needs you, Quotas) | yes (#1031: Needs you only; no Quotas widget by owner's choice) | not yet |
| Notification: questions | yes (Web Push) | yes | yes | yes (#1137: a service extension opens the sealed box in place of the server's placeholder; delivery on a device waits for TestFlight) |
| Notification: permission prompts | yes (taps open the page; no Allow/Deny) | yes (Allow / Deny buttons) | yes (no Allow/Deny; opens window) | yes (#1137: Deny answers from the notification; Allow opens the prompt, which shows the whole input first) |
| Notification: runs | yes (#1064: pass or fail, while a page is open; runs skip Web Push) | yes (Live Update on Android 16) | yes (#1064: pass or fail, the page's own, shown by the app) | no (APNs gets no runs, as Web Push) |
| Notification: quota alerts | yes (only while a page is open) | yes (low-importance channel) | yes (the page's own, shown by the app) | yes (#1235: only when the app reads quotas, while it is open or woken by another push, since APNs gets no quota snapshots; quiet, in Notification Center) |
| Answer from a notification: option buttons | yes (only if every option fits the browser's action limit) | yes (at most 3 options; 2 when the question also takes replies, #1339) | yes | yes (#1137: at most 3, the agent's default first) |
| Answer from a notification: typed reply | no (service worker has no input action) | yes (RemoteInput: Answer without options, Reply beside them, #1339) | yes (Reply button) | yes (#1137: Reply, or Answer for a question without options) |
| Presence (holds other devices' pushes) | yes (#848) | yes (#848) | yes (#945, uses Mac lock/idle) | not yet |
| Offline outbox / no answer lost | no (retries 502/503 for 20 s; unsent answer kept in page memory only) | yes (#329, #331: sealed, stored, sent by WorkManager) | no (as web) | yes (#1122, #1137: sealed and stored; sent from a notification in the time iOS gives it, else when the app is open, every 10 s and on pull to refresh; no background retry yet) |
| Update screen / update notice | yes (426 shows a reload-only screen) | yes (#497: "Update Starbridge" screen) | yes (auto-updater from GitHub Releases; 426 as web) | yes (#1122: 426 shows "Update Starbridge"; answers stay in the outbox) |
| Recovery key: copy / save | yes (Copy the key; saved checkbox) | yes (copy to clipboard, #817; save) | yes (as web) | yes at first-device setup (#1116: Copy, clearing after a minute, and "I stored this key"; no Save, since iOS lets no app add a password to the password manager); Replace in Devices (#1240), with the same Copy |
| Devices list (notifies state, app icon, Revoke) | yes | yes | yes | yes (#1238: Settings → Devices and machines) |
| Pairing: show QR for a new phone | yes | yes | yes | yes (#1239) |
| Pairing: scan a QR | no (no scanner in web) | yes (Play services code scanner) | no (as web) | yes (VisionKit: to join this iPhone, #1105; a machine's or another device's code in Devices, with the check key, #1239) |
| Pairing: link (`/pair#code`) | yes | yes (App Link and `starbridge://pair`) | yes (`starbridge://pair`) | yes (`starbridge://pair`, #1239; the https link opens the web page until the app claims it, #1115) |
| Pairing: typed code | yes | yes | yes | yes (#1239) |
| Pairing: approve a join by digits (Compare digits) | yes | yes | yes (as web) | yes (#1158: over any screen while the app is in front; the notification opens the app) |
| Keyboard shortcuts (J K 1-4 A D /) | yes (from 1100 px) | no (only Enter to send, Esc in Find) | yes (as web) | not yet |
| Sound | yes (off by default, only while a page is open) | yes (system notification channel sound) | yes (macOS default sound; Basso on "Answer not sent"; web Sound row hidden) | not yet |
| Recover with the recovery key (revokes every other member) | yes | yes | yes (as web) | yes (#1116) |
| Delete account (Settings and the join screen, its recovery-key view included, typed confirmation) | yes (#1104, #1117) | yes (#1104, #1117, #1166) | yes (as web) | yes (#1141, #1195, #1233: Settings and the join screen, its recovery-key view included) |

Only on desktop: the menu bar light, the Dock or menu bar choice, Open at Login, ⌃⌥S, and notifications while no browser runs.
