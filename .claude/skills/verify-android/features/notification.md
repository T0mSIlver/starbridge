# A question's notification

A question reaches a phone as an FCM message; the app shows a notification with
the question, its context and the options as actions (the first is the default),
and a Reply action for a typed answer.

## Sub-features

- `shown`: the notification exists (`dumpsys notification --noredact`).
- `actions`: option buttons and Reply.
- `open`: tapping it opens the card.

## How to get to it (user POV)

- The notification shade, with the app in the background.

## Driving it with android.ts

Preconditions: the app signed in and joined, its push subscription on the server.

- The machine asks: `ask(dir, QUESTION, CONTEXT)` prints the decision id.
- The server sends to the fake FCM (`fcm.messages`); the script pushes that
  payload with `am broadcast -a com.google.android.c2dm.intent.RECEIVE -n
  dev.starbridge.app/com.google.firebase.iid.FirebaseInstanceIdReceiver --es p …`,
  which needs `adb root`, so a `google_apis` image.
- Result: `dumpsys notification` contains the question; `cmd statusbar
  expand-notifications`, then `see` the question's text.

## Gotchas

- With `NO_FIREBASE` the app's subscription is a made-up token that the script
  writes to the server's database: a PR's evidence proves the notification, not
  FCM registration.
- A killed run can leave the shade open.
