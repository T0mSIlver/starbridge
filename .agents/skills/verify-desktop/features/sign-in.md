# Sign-in and the first device

The app opens the server's page. Signed out it shows "Sign in to Starbridge", not
the landing page. "Sign in with GitHub" sends the sign-in to the owner's browser,
which returns with a `starbridge://auth` link; the app then makes the account's
keys and its recovery key.

## Sub-features

- `server`: "Use your own server" opens the app's own Server window.
- `browser`: the sign-in leaves for the browser (`shell.openExternal`).
- `keys`: the recovery key, "Name this app", "I stored this key", "Create the account".

## How to get to it (user POV)

- First launch of the app. A deep link `starbridge://auth` while it runs.

## Driving it with stack.ts

Preconditions: the stack up (the first steps of the file).

- Heading: `getByRole("heading", { name: "Sign in to Starbridge" })`.
- The click must be a mouse click at the link's box (`page.mouse.click`): the app
  opens the browser only for a real click (#1721).
- The test plays the browser: it takes the URL from `g.outside`, follows the
  redirects with a cookie jar until a `starbridge:` link, and hands it to the app
  with `app.emit("open-url", …)`.
- Then: "Save your recovery key" with the key and "Name this app", the checkbox,
  "Create the account", and the inbox says "Add a machine".

## Gotchas

- The default name is `Starbridge on Mac` or `Starbridge on Linux`: a comparison
  with a Mac's evidence differs there.
- The recovery key page shows a key that changes every run (masked in evidence).
