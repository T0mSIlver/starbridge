# Clients

- **Inbox order.** Runs first, then permission prompts, then questions whose agent waits, then the
  rest, each oldest first. The view offers one feed, "Group by machine" or "Group by waiting"
  ("Waiting on you", "When you can"), remembered per device.
- **One card system** (#248). Every item is a filled card; what blocks an agent differs by one
  thing, the amber fill. A waiting item's title is weight 500 and its time slot a clock ticking
  from when it started waiting; screen readers hear "Waiting for you, 2 minutes" first. No state
  tag anywhere. Under a grouping, the items under one header are joined.
- **Less on a question** (#970). The owner found the detail crowded, and half of it repeated
  itself in names nobody chose. Claude Code works in worktrees with generated names and names an
  unnamed session `<directory>-<hex>` (`nameSource: "derived"`), so the meta row showed the
  worktree and the session line a made-up name. The CLI now sends a git worktree's repository as
  the project and replaces a derived session name with the session's first sentence
  (spec/harnesses.md, #1181); clients show no bare session id either.
  The detail ends with one line: Snooze (Back now, Done) on the left, the session's name on the
  right as the link that opens it in Claude or Codex, or "Open in Claude" when it has no name. The
  "Attached by the agent" caption went: the chips sit inside the agent's words. The owner chose
  this from mockups of every element.
- **Snoozed** (#571, #692, #699). Snooze sits under the reply field in a question's detail (web)
  and sheet (Android), never on a notification. Most snoozes are for later the same day, so it opens on
  today: 1 hour and This evening (18:00, offered until 17:00), then the days as chips (today and
  the 7 after it) and a time an hour ahead, up to the half hour (9:00 on another day), from 5
  minutes on, confirmed by "Snooze until 15:00". Android sets the time on a dial; the web types
  it, to the minute, in the browser's time field, whose 12 or 24 hours follow the browser's
  language rather than the Clock setting. Phones open the times in place under Snooze; the
  desktop web opens them in a popover. A
  snoozed question leaves Needs you, the count and the badge, and its notification closes on
  every device; it waits in a collapsed "Snoozed · n" group after them, soonest back first, its
  time slot "Until 18:00", with no amber and no answer buttons even when its agent waits. Opened,
  it says "Snoozed until …" and offers Snooze again (replaces the time) and Back now. At its time
  it returns to its place and notifies once, "Back from snooze", never again. The owner chose
  these from mockups.
- **An answer closes its question at the tap** (#895). The question leaves the open list on the
  next frame, and History shows the answer "not sent yet" until the server takes it. If the server
  refuses it, the question comes back saying "Not sent:" and why, and answering again resends it.
  Waiting for the server's reply kept the card up for its round trip, about a second on a phone.
  Answered from its open view, the view goes too (#927): Android's sheet, a question's or a
  prompt's, slides away with Material's own dismiss onto the inbox without the card, and the web
  shows the next open item beside the list, or the list on a phone. A refused answer comes back in
  the list, never in a reopened view. Left open, the view showed an answer the owner had just
  given.
- **History** lists answered questions and the last 7 days of prompts, with how and where each was
  answered. A question settled `elsewhere` without a page to answer in was answered in the
  agent's own picker or terminal, so it reads "at the keyboard", never "by the agent", which
  stays for a withdrawn question or one answered on its page (#865). A withdrawn question with a
  reason shows the reason in its place: "Withdrawn · Fixed it myself after rereading the logs"
  (#1008). The owner chose it from mockups over a line of its own and over the reason after
  "Withdrawn:", which pushed the rest off a phone's row.
- **History loads the last 7 days** (Tom, 2026-10-12, #1380): the server's own, since it drops
  an answered question 7 days after its answer. Older rows, which a browser kept, wait behind
  "Show older" at History's end; Find searches every row. An answered question's images
  download when they come on screen in its detail (Tom, 2026-10-12, #1382): History rows show
  none, so a long history costs no image the owner does not open. The server lists answered
  questions without them (`blobs=open`), and the browser keeps them once fetched.
- **Closed sections wait at the bottom** (#662, #682). Closed, History sits at the bottom of a
  short inbox and Snoozed just above it, out of the way; opened, each glides up under the items
  and its rows fade in. Opening Snoozed leaves History at the bottom.
- **Find** matches every word in the machine, repo, the agent's words, the session and a History
  item's answer. On the web it lists open matches, then History's; Android uses Material 3's
  search view.
- **Answer buttons** (#138, #166): "Answer buttons on narrow screens", Always (default), When the agent
  waits, or Never, applies under 1100 px. More than two options, or a label over 18 characters,
  stack. An `answerIn` question gets its page's link and Done when its machine takes a Done
  (#539, #1148); a typed-only question has no buttons.
- **Typed answers** (#562): Enter sends, Shift+Enter starts a new line, on the web and with an
  Android hardware keyboard. An Enter that ends an input method's composition only commits it.
- **The reply field** (#947) grows to 10 lines, then scrolls, on both clients. On the web it is one
  box: the text on top, then a row inside the box with the keys ("Enter to send · Shift+Enter for
  a new line", hidden on touch screens) left and send right. A send arrow inside the field's line
  had long replies running under it in the desktop app. The owner chose this from mockups over a
  send button beside the field and a separate bar under it. Android keeps Material's trailing
  icon, which the text wraps before.
- **Drafts** (#992). A reply typed and not sent stays with its question: on Android across
  rotation and process death, on the web until the page reloads. The web's detail moves between
  the phone and wide layouts as the window is resized, and a draft kept in the field alone was
  lost there.
- **Context** (#969) renders the subset the skill names, the same on the web, the desktop app and
  Android: each line on its own, blank lines only separating; `**bold**`; code, inline and
  fenced; `-` and `1.` lists with a hanging indent; links, bare or `[text](https://…)`. A `#`
  heading is a bold line. Anything else shows as typed. `packages/protocol`'s `parseContext`
  parses it, ported to Kotlin with shared vectors, and notifications show the same text plain.
  Each line on its own makes a line per option read as a list; bold lets the labels lead it.
- **Selectable text** (#1143). A question's words can be selected and copied, so a command an
  agent asks about can be pasted elsewhere: on its card, the question; in its detail, the
  question, the context, the answer and a prompt's full input. A long press (Android, iOS) or a
  drag (web) selects; a tap still opens the question, and options and swipes work as before. On
  the web card the question sits above the row's button: a click that does not drag still opens
  the row.
- **`\n` in `--context`** (#1037). Models in opencode wrote `\n` for line breaks inside the
  quoted `--context`, which the shell passes on as typed, and cards showed a backslash and an n.
  The skill says to break lines with real line breaks inside the quotes. `ask` also turns `\n`
  into a line break when the `--context` argument holds no real line break, the one case where it
  is unambiguous: never inside a code span, never after a backslash, and never from
  `--context-file` or `--input`. Fenced code needs real line breaks, so none is touched. The
  cost: a Windows path written outside a code span, `C:\new`, breaks after `C:`.
- **Revoked machines.** Their items leave the Inbox and their notifications close (#344).
- **Clock** (#161): System, 12-hour or 24-hour, per device. UI words stay English.
- **Images** open a full-screen viewer (zoom, pan, swipe or arrow keys between images) and carry
  an expand badge, since nothing else tells a touch screen they open (#170).
- **Image rows** (#536). A question's images go two to a row, both at one height and each as wide
  as its shape asks, together filling the row (at most `size.media` tall): no grey bands, no
  crop, no frame. With one image per option, two or more, each image sits over its option's
  button in equal columns, in the agent's order: its own shape, no wider than the button and at
  most `size.pick` tall, the row's images centred on one midline so the buttons line up. The owner
  chose both from mockups. The reply field sits under them, as under plain options.
- **Signed out.** A browser that holds no device of the account it last signed in to gets the
  landing page at `/`, as does a revoked browser (#209); one with a device gets sign-in.
- **Restarts go unnoticed** (#250). Clients retry a 502, 503 or refused connection quietly for
  20 s. A write retries only when it cannot have landed; the web's writes retry on 502 and 503
  only, since it cannot tell a refused connection from a cut one.
- **Rate limits** (#645). A 429 with `Retry-After` (seconds or a date) holds every call of the
  page or app until then, first tries included, and the call is retried whatever its method, since
  it was refused before doing anything. A wait past the 20 s retry window reaches the caller as
  429 `rate-limited`. A 429 without `Retry-After` is a cap and reaches the caller at once. A
  presence beat's 429 holds nothing else: its limit is per device and route, and the next beat
  retries, so a few reloads in a minute no longer refuse a settings write for a minute (#1361;
  web so far, Android and iOS in #1372).
- **Settings** (#914) in the same sections on both clients: Notifications (what decides whether
  something notifies here: Android's channels or this device's switch (#943), the hold, the web's
  sound, Android's Allow from notifications), Quotas (see "Quota alerts per window"), the Inbox's,
  Devices, Look (colours and the clock) and Account (the server, Android's push delivery, agent
  instructions, sign out). They had grown one issue at a time: the hold sat under Inbox on the web
  and under Notifications on Android, and push delivery, a connection setting, sat with
  notifications.
- **No quotas, no Quotas tab** (#914). Until the server holds a quota snapshot for the account,
  opened on this device or not, the Quotas tab, its settings and the web's quota column stay
  hidden, so an owner who skips CodexBar never sees an empty feature and the app stays about
  agents. A device that just joined sees the tab at once, since the snapshot it cannot open yet
  still counts. The tab appears as soon as a machine's first snapshot arrives: the server pushes
  that one even when it is quiet, since a phone whose pushes work does not poll and would
  otherwise learn of it only at its next start or pull (#1010).
- **Devices.** Each device shows whether it notifies, as it last said (#943), and an icon for the app it said it from (#1019): a phone for the Android and iPhone apps, a globe for a browser, a laptop for the desktop app, a server for a machine (the owner's pick of two sets). The server knows the app from how the device signs in (a bearer token, the session cookie, the desktop and iPhone apps' client header), so devices paired before show theirs without pairing again; one that has not said yet shows a plain device. Rows that share a name show when each was added (#287). A Recovery key row says
  when and on which device the key was set, with Replace; other devices show a replacement once
  (#348).
