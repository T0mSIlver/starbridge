# Sign-in

- The hosted server signs in with GitHub; a self-hosted server with `OWNER_TOKEN`.
- **Sign in with Apple** (#1411). App Store guideline 4.8 asks an app that signs in with GitHub
  to offer a login that keeps the email private too; websites are not bound. GitHub stays the
  main sign-in everywhere, and Apple shows only where it must: on the iPhone, GitHub's button
  then Apple's at the same size (4.8 wants Apple's no less prominent); on the page, Android and
  the desktop app, a small "Other ways to sign in" link under GitHub's button, so an account made
  with Apple on the iPhone can add a browser or an Android phone. So that a new browser reaches
  it, the landing page's header Sign in opens the sign-in screen; its hero button stays GitHub's.
  A self-hosted server has no
  Apple key, so its clients show only its own methods.
  - Starbridge asks Apple for no name and no email, as it keeps no email from GitHub: the data
    is end-to-end encrypted and an account is only a sign-in's stable id. So Hide My Email never
    arises, and the privacy page stays as it is. The server keeps Apple's user id (`sub`) and the
    refresh token of the account's last Apple sign-in, only to revoke it when the account is
    deleted, which Apple asks of an app that deletes accounts.
  - An Apple id no account holds makes a new account, as a new GitHub id does; accounts are not
    linked. Each signs in with its own provider everywhere, so nothing needs linking, and a
    GitHub user who taps Apple by mistake gets an empty account that Delete account removes.
  - The iPhone signs in natively (AuthenticationServices), with a nonce Apple puts in the
    identity token and an authorization code the server trades once, so a token caught on its
    way is worthless (PROTOCOL.md, "Auth").
- The owner can pause sign-ups (#784), for a launch-day flood or a box near its limits: a GitHub
  user with no account gets "not taking new accounts right now" on the page and in the app, while
  every existing account signs in as before. `bun server.js signups pause|resume` writes and
  removes a file beside the database, which the server reads on each new account, so it takes
  effect at once and survives restarts and deploys.
- A server can list who may sign up (#1524): with `SIGNUP_GITHUB_IDS` set, only those GitHub
  users can make an account (no Apple or owner account is made beside it), so the staging server
  takes no strangers; a value that is not a list of ids stops the server. Others get the paused
  sign-ups' 403 `signups-paused`, which every client already shows as "no new accounts here",
  so no client changed.
- The page shows only the sign-in methods its server offers (#670): `GET /v1/auth/methods` lists
  them, and without GitHub the landing page's and sign-in page's buttons open the owner token
  form. Until the server answers, the page shows GitHub, the hosted server's, so the landing
  page's HTML keeps its buttons.
- Android (#34, #527): the app signs in with PKCE, and GitHub binds its code to the app's
  challenge, so only the app holding the verifier can trade the code, whoever catches the
  redirect. Known gap: a hostile app can start its own sign-in, and if GitHub skips the consent
  screen it gets a session.
- On starbridge.run, GitHub redirects the app's sign-in to `/v1/auth/github/callback/app`, an
  App Link the app catches (#527). The installed web app's scope is the whole origin, so Chrome
  handed it the page's callback when no other app claimed that; where both claim a URL, Chrome
  opens the verified app. The page's sign-ins keep `/v1/auth/github/callback`, which the app does
  not claim, so they stay in the web app.
- When the browser gets the app's redirect (app missing, verification failed), the
  server passes GitHub's code on to `APP_REDIRECT_URI`: on starbridge.run the App Link
  `https://starbridge.run/app/auth`, whose page has an "Open Starbridge" button to
  `starbridge://auth`. Chrome asks "Continue to Starbridge?" before following a `starbridge://`
  redirect that no tap started; after a tap it does not. Self-hosted servers keep
  `starbridge://auth`, since the APK can bind only starbridge.run.
- iPhone (#1105): the same PKCE sign-in through `ASWebAuthenticationSession`, which shares
  Safari's GitHub sign-in. On starbridge.run from iOS 17.4 it ends on the https callback
  `/v1/auth/github/callback/app`, as Android's App Link does, so the owner taps nothing after
  GitHub (#1115): `/.well-known/apple-app-site-association` lists the app for that path
  (applinks) and for webcredentials, which the https callback requires, and the app's Associated
  Domains name starbridge.run. Older iOS and self-hosted servers, whose domain cannot list the
  app, end on `starbridge://auth`, so on starbridge.run they stop on `/app/auth` and the owner
  taps Open Starbridge once.
- `assetlinks.json` lists only the release key, which Play App Signing also uses. A debug
  keystore's password is public, and an app signed with it would verify as the App Link handler
  (#569). Dogfood builds sign with the release key instead, opted into by a gitignored
  `local.properties` line on the maintainer's machine and refused under CI; other debug builds keep
  the debug key, and their sign-in falls back to the `starbridge://auth` button.
- **Account deletion** (#1104). App Store guideline 5.1.1(v) requires an app that makes accounts
  to delete them from inside the app, and Play asks the same, so Settings on the web page (and
  so the desktop app) and on Android has Delete account, which works once the owner types
  "delete". `DELETE /v1/account` removes every row of the account in one transaction and signs
  out all its sessions and machines. Any signed-in session may delete, paired or not: whoever
  signs in must be able to, and the GitHub sign-in behind a session controls the account anyway.
  So the join screen ("Add this phone", "Add this browser") has Delete account too, its
  recovery-key view included, where an owner with a lost key looks (#1117, #1166): with
  no device and no recovery key it is the only way out, since the data is end-to-end encrypted
  and nobody, the server included, can read it or vouch for a new device. Its dialog says so.
  The deleting client forgets the account's keys as Sign out does; other devices keep theirs
  until they sign in again, find a new empty account, and offer to remove them. Backups keep
  the data for up to 2 weeks, as /privacy says.
