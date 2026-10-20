# Push

- FCM and APNs go through the relay, since their credentials belong to the app's Firebase project
  and Apple team. Web Push
  goes through the relay only when a server has no VAPID keys; UnifiedPush always goes direct. The
  relay is open, rate-limited per IP and in all (600 a minute in Caddy; in the server, 64 Web
  Pushes in flight, 4 per address, 8 per IPv6 /48 and 16 per push service host), so nobody can
  aim it at a host or burn the VAPID key (#577). A push service that never answers holds a slot
  for 10 s; the per-host cap bounds what any one host gets, and the caps per sender leave the
  rest to other servers. The server refuses relay mode with any `ALLOW_PRIVATE_PUSH_ENDPOINTS`
  host, since those are for a self-hoster's own network. It
  pushes only ciphertext or ids. A push carries the
  device's ciphertext when it fits FCM's 4 KB, else the item id.
- Quota snapshots and runs skip Web Push: browsers drop subscriptions whose pushes show no
  notification (Firefox after 16). The web page polls them instead. They skip APNs too, where a
  silent push may never arrive; the iPhone app fetches them.
- **Every Web Push to Safari shows a notification** (#1363). Safari drops a site's push
  subscriptions once three of its pushes, counted over the subscription's whole life, showed no
  notification within 30 s (WebKit's `maxSilentPushCount`), and permission stays, so nothing
  told the owner. Every answer pushed `answered` to each device the question was sealed to, the
  answering iPhone included, so after three answers the Home Screen app stopped getting
  questions until it subscribed again: some questions notified and some only showed in the
  inbox. So what only closes or hides a notification (`answered`, a settled notice, a snooze as
  posted) skips subscriptions on Apple's push service; the page closes those notifications when
  it reads the inbox and the prompts, as the iPhone app syncs when it opens. The service worker shows something
  for every push that asks for the owner: its notification, or after 20 s still opening, or when
  its fetch or check fails, the placeholder the iPhone app uses ("A question needs you"), which
  opens the inbox and which the real notification replaces. On Safari, a push that ends with
  nothing to show, such as a question answered before the phone woke, shows a quiet "Nothing new
  needs you" that the page closes once open. Other browsers stay silent there, since they allow
  some. A browser the owner turned on that boots with permission granted and no subscription
  subscribes again, without asking (one that reads "default", as in #1362, sends only a
  subscription it holds); one never turned on still waits for the banner or the
  switch. An iPhone that lost its subscription before this fix needs the banner's tap once. Question
  pushes already went at `Urgency: high` with a day's TTL and no `Topic`, so those were not the
  cause.
- **APNs for the iPhone app** (#1076). iOS throttles data-only pushes and drops them for an app
  the owner swiped away, so what asks for the owner (a question, a waiting flip, a snooze's
  return, a permission prompt, a join request) goes as an alert with `mutable-content`: the app's
  notification service extension opens the box and replaces the placeholder ("A question needs
  you"), and if it fails the placeholder shows, which says nothing private. That placeholder keeps
  no button that answers a question, since its text is the server's own; a prompt's Allow and
  Deny stay, as the app reads the prompt before acting on either (#1354). A question keeps one
  notification: its waiting flips and its snooze's return carry its id as the collapse id, and
  replace it. What only closes or hides a notification (`answered`, a settled notice, a snooze as
  posted) goes as a background push, which iOS may hold or drop, so the app syncs when it opens;
  an alert that says "Answered" would close it reliably but leave a notification behind. Alerts go
  at priority 10, background pushes at 5 (APNs refuses 10 for them), and both expire after a day,
  as FCM's do. The server signs with the team's auth key (.p8), whose token never expires, and
  keeps one HTTP/2 connection to Apple open. A subscription names its environment, sandbox for a
  build from Xcode. The server drops it on 410, or when both environments refuse the token: a
  debug build's token sent to production is `BadDeviceToken` there, and dropping it for that
  would silence a phone that works, the lesson of #1011. The iPhone app registers its token at
  each start, as Android does.
- **The iPhone's app icon badge** (#1603). The icon carries the Needs-you count, as the Mac's Dock
  does (#1602): open questions and permission prompts, snoozed ones out until they return, none at
  0 or signed out. The server sends no `badge`, since it cannot count: snoozes and settled
  notices are sealed. The notification extension sets the count on each alert it rewrites, from
  the inbox the app saved plus that alert's item, and the app sets it as its inbox changes. A
  push that only closes an item is a background push, which wakes the app to sync and recount
  unless iOS holds it or the owner swiped the app away; then the badge counts one already gone
  until the app opens. Only an alert would always run the extension, and an alert shows a
  notification; hiding it takes Apple's notification-filtering entitlement. iOS's Badges setting
  for the app decides whether it shows.
- **The iPhone treats a push as a hint** (#1756). A payload whose `id`, `re` or `kind` is not
  plain words (`[A-Za-z0-9_-]{1,64}`, `[a-z-]{1,32}`) is dropped, since the id joins a request
  path. A notification's button acts only when its category is the question's own (`d.<id>`; a
  prompt's Deny needs `permission`): the server names the category until the extension rewrites
  it. The extension shows no button for an item the app's saved state says is answered, so a
  replayed push cannot offer to answer it again, and it clears the badge the placeholder carried
  when it keeps the placeholder.
- Caps (#27, #36, #37): 10 subscriptions a device, 30 an account; 4 pushes in flight and 200
  waiting per account, 10 s each. A push connects to the exact address that passed the
  private-range check, and is sent only if its subscription and device are still active (#260).
  An IPv6 address that embeds an IPv4 one (IPv4-compatible, IPv4-mapped, IPv4-translated, NAT64,
  6to4) is judged by that IPv4 address, since a translator on a self-hoster's network can route it
  there (#1095). Teredo and ISATAP addresses are refused whole: both are deprecated, and no push
  service uses them.
  `ALLOW_PRIVATE_PUSH_ENDPOINTS` names the private hosts a self-hoster's push endpoints may use,
  such as their own ntfy, over plain HTTP too; every other private address stays refused, since
  any account on the server could otherwise make it call into the owner's network. Relay mode
  refuses any listed host. `1`, from when it was a yes/no flag, still allows every private host, with a
  warning at startup.
- A Web Push or UnifiedPush endpoint on a public host must use port 443, where every push service
  listens, and an account's subscriptions may name at most 8 push service hosts; the server has
  at most 32 pushes in flight to one host, its own and relayed ones together (#1738). Otherwise a
  subscription could make the server probe any port of any host, or hold many requests open on
  one. A self-hoster's distributor on another port goes in `ALLOW_PRIVATE_PUSH_ENDPOINTS`.
- A server's VAPID key can change, as when a self-hoster leaves the relay for their own keys
  (#567). Each page boot compares the browser's subscription key with the server's and subscribes
  again when they differ. The server drops a Web Push subscription its push service refuses as signed
  by another key: 403 from FCM and Apple, as RFC 8292 has it, and 401 from Mozilla and Windows
  (#2083). A UnifiedPush 401 or 403 is the distributor's access control and keeps the target. The
  cost: each service answers the same status for any bad signature, so one for another reason,
  such as a server clock hours off, drops the account's browser subscriptions too, and each comes
  back only when its page opens. Those pushes were failing anyway.
- **Notifications on this device** (#943). With the desktop app on a Mac, Brave's service worker
  went on notifying too, so every question came twice, and the only ways out were the browser's
  site settings or revoking the browser. Settings → Notifications on the web and in the desktop
  app opens with this switch. A browser's off drops its own Web Push subscription, which nothing
  renews until the owner turns it back on, and no banner offers it again; on asks for the
  browser's permission when it is missing, then subscribes; blocked by the browser, the switch
  is disabled and the row says where to allow it. The desktop app's off stops its notifications
  while the menu bar light still shows what waits. Android keeps its own controls (system
  settings, channels), which the app only reads. Each device turns only its own notifications
  off, never another's (owner's rule), and says its state to the server, so Devices shows every
  device on, off or blocked, read-only.
- **A browser's push is on when it holds a subscription** (#1362), whatever
  `Notification.permission` says short of denied. In an iOS Home Screen app, the window a
  notification's tap opens reads permission as "default" although it stands, so the Inbox offered
  notifications again at random and Devices listed the iPhone off. A browser drops its
  subscription when permission goes, so the subscription is the truer signal. Read before the
  service worker is active, a subscription can read as none, so the page waits up to 3 s for the
  worker before saying off. A tab reading `denied` is blocked only when no subscription, push
  manager permission or Permissions API answer says otherwise: macOS Safari 27 keeps reading
  `denied` in the tab where the owner just clicked Allow (#1404).
- **The hand-off to the desktop app** (#943). The app's GitHub sign-in passes through
  `/app/auth` in the default browser of its own machine. When that browser holds a device of the
  same account with notifications on, which the server confirms once the app traded its code,
  the page offers to turn off this browser's notifications, one tap. The server keeps no IP or
  user agent, so this is the one case where two devices are known to share a machine; a browser
  opened beside an app already signed in gets no offer, since that would be a guess (owner's
  rule). The owner chose this from mockups over offers by device name both ways and over the
  switches alone.
- An Android app in front syncs every 10 s until a push has reached it (#445), since a server
  without a relay or UnifiedPush pushes nothing and cannot tell. A push that waits for a sync
  holding the store past FCM's time is still handled once the sync ends, rather than dropped, since
  that push has already stopped the polling that would have read its item (#1497).
- **Android registers its push route at each start** (#1011), even when its token is unchanged.
  The server drops a subscription FCM once calls gone, and the phone, still holding the same
  token, never sent it again until a reinstall. An app update does not change the token or stop
  delivery: on the emulator, updates to a newer, the same and an older release all kept the token,
  and FCM woke the app before it was opened. Registering is idempotent, so the cost is one
  request per start.
- **Held pushes** (#848). A question that shows in the agent's picker and on the owner's screen
  needed no buzz on the phone too: a quick back and forth at the desk did that. So while any of
  the owner's machines or devices says they sit at its screen, the push of a question, a
  permission prompt or a waiting flip waits for every device not itself in use, and goes only if
  nothing answered it meanwhile. It waits as long as the owner stays, then the account's hold time
  (30 s by default; 0 s to 1 minute, or off, in Settings) from when the last screen stopped saying so
  (#1003): a fixed time from the question rang the phone at a desk the owner never left, and
  timed a walk away from the wrong moment. Coming back within the hold time holds again. What
  bounds a hold is each source's own reading, input in the last minute, so a Mac left unlocked
  stops holding a minute after its last key; a source that says present wrongly (#990) holds
  until it stops, or 30 minutes at most (#2189): any paired machine may say present, and one that
  never stops would otherwise keep every phone silent. A question left that long at a screen
  rings the phone anyway. Only the push waits, never the item: every device lists it at once, and a held card
  looks like any other, since the owner chose no state that flips while they look. With no presence
  signal, which is every older client, pushes go at once as before. The server reads presence as
  one bit per source, in memory, since the hold is all it is for: no idle time, lock state or
  reason, nothing on disk. A restart forgets who was present: a new question pushes at once, and
  a held one counts everyone present for one trusted beat, so a source still there holds it again
  rather than the phone ringing at a restart. Presence counts per person, so a Mac in
  use holds a question from a headless dev box. The hold is one account setting, since the server
  applies it and it is about the person, not a device. PROTOCOL.md, "Held pushes", has the
  timings.
- **Web Push encryption is the server's own code** (#2023). The `web-push` library had no release
  since January 2024, and the server used one call of it: encrypting the payload and signing the
  VAPID header. `server/src/webpush.ts` does both with WebCrypto, one aes128gcm record (RFC 8291)
  and an ES256 JWT valid 12 hours (RFC 8292), and sends the same headers as before (TTL, Urgency,
  no Topic). Its tests hold it to RFC 8291's example byte for byte and to `http_ece`, kept as a
  test dependency, in both directions. FCM and APNs never went through it.
