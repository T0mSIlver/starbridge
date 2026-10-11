# Push

- FCM and APNs go through the relay, since their credentials belong to the app's Firebase project
  and Apple team. Web Push
  goes through the relay only when a server has no VAPID keys; UnifiedPush always goes direct. The
  relay is open, rate-limited per IP and in all (600 a minute in Caddy; 16 Web Pushes in flight
  in the server, 4 per address), so nobody can aim it at a host or burn the VAPID key (#577). It
  pushes only ciphertext or ids. A push carries the
  device's ciphertext when it fits FCM's 4 KB, else the item id.
- Quota snapshots and runs skip Web Push: browsers drop subscriptions whose pushes show no
  notification (Firefox after 16). The web page polls them instead. They skip APNs too, where a
  silent push may never arrive; the iPhone app fetches them.
- **APNs for the iPhone app** (#1076). iOS throttles data-only pushes and drops them for an app
  the owner swiped away, so what asks for the owner (a question, a waiting flip, a snooze's
  return, a permission prompt, a join request) goes as an alert with `mutable-content`: the app's
  notification service extension opens the box and replaces the placeholder ("A question needs
  you"), and if it fails the placeholder shows, which says nothing private. A question keeps one
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
- Caps (#27, #36, #37): 10 subscriptions a device, 30 an account; 4 pushes in flight and 200
  waiting per account, 10 s each. A push connects to the exact address that passed the
  private-range check, and is sent only if its subscription and device are still active (#260).
  An IPv6 address that embeds an IPv4 one (IPv4-compatible, IPv4-mapped, IPv4-translated, NAT64,
  6to4) is judged by that IPv4 address, since a translator on a self-hoster's network can route it
  there (#1095). Teredo and ISATAP addresses are refused whole: both are deprecated, and no push
  service uses them.
- A server's VAPID key can change, as when a self-hoster leaves the relay for their own keys
  (#567). Each page boot compares the browser's subscription key with the server's and subscribes
  again when they differ. The server drops a Web Push subscription its push service refuses with
  403, as RFC 8292 has it for a key mismatch; a UnifiedPush 403 is the distributor's access control
  and keeps the target. The cost: a 403 for another reason, such as a server clock hours off, drops
  the account's browser subscriptions too, and each comes back only when its page opens. Those
  pushes were failing anyway.
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
- **The hand-off to the desktop app** (#943). The app's GitHub sign-in passes through
  `/app/auth` in the default browser of its own machine. When that browser holds a device of the
  same account with notifications on, which the server confirms once the app traded its code,
  the page offers to turn off this browser's notifications, one tap. The server keeps no IP or
  user agent, so this is the one case where two devices are known to share a machine; a browser
  opened beside an app already signed in gets no offer, since that would be a guess (owner's
  rule). The owner chose this from mockups over offers by device name both ways and over the
  switches alone.
- An Android app in front syncs every 10 s until a push has reached it (#445), since a server
  without a relay or UnifiedPush pushes nothing and cannot tell.
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
  until it stops. Only the push waits, never the item: every device lists it at once, and a held card
  looks like any other, since the owner chose no state that flips while they look. With no presence
  signal, which is every older client, pushes go at once as before. The server reads presence as
  one bit per source, in memory, since the hold is all it is for: no idle time, lock state or
  reason, nothing on disk. A restart forgets who was present: a new question pushes at once, and
  a held one counts everyone present for one trusted beat, so a source still there holds it again
  rather than the phone ringing at a restart. Presence counts per person, so a Mac in
  use holds a question from a headless dev box. The hold is one account setting, since the server
  applies it and it is about the person, not a device. PROTOCOL.md, "Held pushes", has the
  timings.
