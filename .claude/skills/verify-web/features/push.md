# Web Push

With notifications on, a browser gets a Web Push for each question and
prompt, shown by the service worker as a notification with the options as
actions where the browser can show them. Answering anywhere closes it.

## Sub-features

- `subscribe`: "Turn on notifications" in the inbox banner, or Settings.
- `notify`: a notification per question, titled with the question.
- `close`: an answer from any device closes the notification.
- `hold`: while one device is in use, the others hear nothing until it
  leaves (devices part, #848).

## How to get to it (user POV)

- The inbox's "Get a notification when an agent needs you" banner.
- Settings, Notifications.

## Driving it with drive.ts

Preconditions: the context has the `notifications` permission (drive.ts
grants it).

- Turn on: `getByRole("button", { name: "Turn on notifications" }).click()`;
  `services.waitFor(/"event":"subscribed"/)`.
- Push sent: `services.waitFor(/"event":"push"/)` after the ask.
- Shown: the service worker's `registration.getNotifications()` titles
  include the question (`scenarios/push.ts`).
- Closed: after the answer, the titles no longer include it.

## Gotchas

- Firefox draws notifications outside the page: screenshots never show them.
  Prove them through `getNotifications()`.
- Firefox now and then drops a subscription mid-run; the banner comes back
  and pushes stop. Late checks belong on a browser that subscribed recently.
- Headless Firefox has no notifications: always run under `xvfb-run`.
