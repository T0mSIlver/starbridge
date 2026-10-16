# The launcher icon

The app's icon in the app drawer, beside the stock apps' icons: the same circle
size, the arch and dot centred. It has been wrong four times in review.

## Sub-features

- `drawer`: the drawer under the launcher's own shape (`<profile>-apps-<scheme>`).
- `shapes`: the drawer under each icon-shape overlay the image offers.
- `badge`: a notification dot while a question is open.

## How to get to it (user POV)

- Swipe up on the home screen.

## Driving it with evidence.ts

Preconditions: `EVIDENCE` set; a question open (for the badge).

- `kept.launcher()` goes HOME, swipes up, waits for "Starbridge", and keeps the
  screen. `cmd overlay list` names the shapes the image offers; each gets
  `cmd overlay enable-exclusive --category com.android.theme.icon.<shape>`.
- Judge it against the neighbours on the same screenshot, at full size.

## Gotchas

- The API 36 `google_apis` image offers no icon-shape overlays, so there are no
  per-shape shots there.
- On the tablet the swipe leaves the home screen: the icon is in the dock.
