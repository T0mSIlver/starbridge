# Android

- Material 3 Expressive, by the guidelines (#49). Colours: "Starbridge" (default) or "Material
  You"; amber, the quota states and provider colours stay fixed under both.
- **Notification channels** (#191, #196): "Needs you" (Waiting for you, high importance;
  Questions, default; Permission prompts; Join requests) and "Activity" (Runs; Quotas, low).
  Android never lowers an existing channel's importance, so changing one needs a new channel id. A
  flip to waiting re-posts the notification on the other channel. Sort keys put questions and
  prompts first.
- **Notifications** show at most three options; a fourth needs the app. A prompt's shows only its
  command. Android's contextual chips are off, so the only buttons are answers. With sensitive
  content hidden, the lock screen's public version carries the same buttons.
- **Lock-screen answers follow sensitive content** (#1375). A question's buttons answer from the
  lock screen only while Android shows sensitive notification content there: notifications on
  the lock screen, "Sensitive notifications" on (a work profile has its own switch), no device
  policy hiding them, and neither question channel set to hide content. Otherwise they ask for the
  unlock, and the receiver refuses an answer that arrives while the phone is locked, since an app
  with notification access can send a button's intent itself (#274). An owner who hides content
  on the lock screen expects the locked phone to take no answers either; one who shows it reads and
  answers there. The setting is read at each post and each answer.
- **No answer is lost** (#329, #331). An answer is sealed, signed and stored before it is posted;
  WorkManager sends it once a network is up. A retry the server already took gets
  `already-answered`, which the app counts as its own when an earlier attempt may have landed.
- **No answer waits for a pull** (#1390; the rule in clients.md). WorkManager's run waits out a
  rate-limit hold before it posts, and a new failure replaces a run waiting in backoff, so the
  answer goes when the hold ends rather than after an earlier answer's backoff.
- **Short outages go unnoticed** (#920). A phone unlocks before its network, or its VPN's DNS, is
  back, so the sync on resume used to fail with the lookup's error. A sync started while Android
  counts no network as validated waits for one; a sync the network or server failed (unknown host,
  timeout, refused or reset connection, 502 to 504) retries quietly after 1 s, doubling to 30 s,
  while the app is in front. Only an outage past 10 s shows, in a snackbar that stays until a call
  gets through: "Offline. Retrying when you're back online." or "Can't reach starbridge.run.
  Retrying.", never the exception's text. Time spent behind counts for nothing toward the 10 s; a
  pull while offline says so at once. The web's reads on `visibilitychange` and `online` already
  fail quietly.
- **Notifications off** (#342): a line heads the Inbox with "Turn on", which opens the app's
  notification settings, since Android stops showing the permission prompt after two refusals.
- **Snooze straight on a time** (#692): the times in clients.md, "Snoozed", with the dial.
  The owner chose this from mockups over a typed time and a grid of half hours.
- **Swipe right to snooze** (#692). A question's card swiped right past 40% of its width snoozes
  it for the time set under "Swipe right on a question": 1 hour (the default), 3 hours, tomorrow
  morning, or Ask for a time, which opens the times over the inbox. A snackbar offers Undo, which
  brings the question back. Let go earlier and the card springs back. The owner chose one
  direction and a set time, so a snooze is one gesture; asking stays a setting. Screen readers
  get a Snooze action instead.
- **Presence** (#848). The app in front and touched in the last minute holds the other devices'
  pushes, as a web page in use does: the owner chose this, since a phone in hand is a screen in
  use as much as a Mac. It counts a touch or key down, never which. Settings → Notifications
  sets the account's hold time, as the web's Settings does.
- Pull to refresh shows only on the screen that was pulled.
- **Haptics** (#997): Android's own feedback constants only, through Compose's haptics (the
  view's for the one Compose lacks), so the phone's Touch feedback setting governs them all; no
  custom vibrations. Answering a question and Allow or Deny confirm: Deny is a choice, not an
  error. An answer the server refused, its question back saying "Not sent", rejects. The snooze
  swipe ticks crossing 40% and again backing under it, but not as the card springs back after a
  snooze. The snooze dial ticks softly per hour or minute, as Android's clock dial does. Quota
  reorder gives a heavy click on pick-up, a tick per place and one on drop, as the launcher
  does. Switches tick on and, lighter, off. Nothing when a sheet opens, a pull refreshes or an
  agent resumes: the tap had its feedback, and a late pulse reads as a new event. Notifications
  keep Android's default vibration: a channel's is frozen once created, and the owner's own
  settings would be lost to new channel ids. The owner picked these in a debug build from six
  candidates, dropping the pull's tick.
- **Home-screen widgets** (#894), in Jetpack Glance. "Needs you" (2×2) counts what the Inbox's
  badge counts: with an agent waiting, that number in amber on the amber card ("waiting on you",
  then how many more "when you can"), else the open questions in `fg`. Quotas (2×2, widened to
  4×2) shows at 2×2 the first window in the Quotas screen's order as a figure, its meter and its
  state, and at 4×2 every window that fits, under its provider, as a meter and a figure. A tap
  opens the Inbox or Quotas. Both follow Colours and the quota settings, and redraw on each change
  to what they show and every 30 minutes, for relative times and snoozes that end. The owner chose
  these from mockups over one-tap answers on a wider Needs you, a runs widget and taller sizes.
  RemoteViews cannot load the app's fonts, so the widgets set in the system's sans, and Glance
  draws no paths, so a meter's overrun shows only its red cap.
- **A Quotas widget says when a window runs out in its own short words** (#912), in red:
  "Runs out tomorrow 06:44", else "Runs out Mon 06:44", "Out Mon 06:44", "Out Mon", the first
  that fits its column whole, measured at the phone's font scale; "Ran out yesterday 22:00"
  shortens the same way. The weekday and time follow the phone's language, zone and the Clock
  setting; today, the time alone ("Out 18:30") replaces the weekday, and a week or more away,
  the date. The Quotas screen's sentence
  ("Will run out on 13 Oct at 06:44") was cut off in a widget's column, losing the time. The
  widget always gives a clock time, never "in 3 h", since a launcher redraws it only every 30
  minutes. Where even "Out Mon" does not fit (Polish "niedz." at font scale 1.3 in a 2×2 at its
  110 dp minimum), it sets smaller (12.5 sp there) rather than cut off.
- **A 2×2 Quotas widget at its 110 dp minimum width cuts nothing** (#915): its heading drops
  the provider ("Weekly" for "Claude · Weekly") when both don't fit, the meter's colour still
  naming it, and its figure sets smaller where "100%" is wider than the column. Raising
  `minWidth` would not help: from Android 12 the launcher sizes a 2×2 by its grid, and the widget
  resizes only across, so its height is always two rows.
- **Each Quotas widget shows the quotas picked for it** (#907). Dropping one opens a picker, as
  Todoist's and Keep's widgets do; Reconfigure on a long press opens it again. A 2×2 takes one
  quota, in one tap; a 4×2 takes two of one plan, side by side as the 2×2 draws one: a plan with
  two is one tap, a plan with more ticks two. "Running out first", the default and what Back
  keeps, shows what leads the Quotas screen, as before. The picker lists every plan, hidden ones
  too. A 2×2 widened to 4×2 adds its plan's next quota. Quotas that stop reporting keep the
  choice, and the widget says "Not in your quotas now" until they return or the owner picks
  again: a machine offline should not cost the choice. The owner chose one quota at 2×2 and two
  of one provider at 4×2 over a whole plan per widget; the side-by-side 4×2 follows CodexBar's
  combined macOS widget. Glance keeps the choice per widget and deletes it with the widget.
- **Update screen** (#497): when the server answers 426 `client-too-old`, the app shows only
  "Update Starbridge", the server's minimum and this phone's release, and one button back to
  where the app came from: Google Play, Obtainium (its launch intent, else the release page), or
  the latest GitHub release. The updated app starts without it. Answers given meanwhile wait in
  the outbox for it. Signed out, the refusal shows as a notice instead, so the owner can pick
  another server.
