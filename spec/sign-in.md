# Sign-in

- The hosted server signs in with GitHub; a self-hosted server with `OWNER_TOKEN`. A server
  refuses to start with an owner token under 16 characters, since sign-in allows a few tries a
  minute and the token is the whole owner account, and with one at all while `PUBLIC_URL` is
  starbridge.run, where it would be one more way into an account (#1720, from an internal
  audit on 2026-10-14).
- In the apps, owner-token sign-in signs in from the keyboard's own key, and a failure stays
  under the fields in the app's words ("Wrong owner token.", "<host> doesn't take an owner
  token.", "No Starbridge server at <host>.", "<host> didn't answer in time.") until the owner
  types or tries again: a snackbar went by under the keyboard and a Play tester saw nothing
  (#2084, iPhone #2085). An address without a scheme gets https://, as a browser reads it.
- **Sign in with Apple** (#1411). App Store guideline 4.8 asks an app that signs in with GitHub
  to offer a login that keeps the email private too; websites are not bound. GitHub stays the
  main sign-in everywhere, and Apple shows only where it must: on the iPhone, GitHub's button
  then Apple's at the same size (4.8 wants Apple's no less prominent); on the page, Android and
  the desktop app, a small "Other ways to sign in" link under GitHub's button, so an account made
  with Apple on the iPhone can add a browser or an Android phone. So that a new browser reaches
  it, the landing page's header Sign in opens the sign-in screen; its hero button stays GitHub's.
  The web and Android button is a pill like GitHub's in Apple's own logo and title, pure black on a
  light screen and pure white on a dark one (Apple's rules for a custom button; DESIGN.md, "Icons"; #1858).
  A self-hosted server has no
  Apple key, so its clients show only its own methods.
  - Starbridge asks Apple for no name and no email, as it keeps no email from GitHub: the data
    is end-to-end encrypted and an account is only a sign-in's stable id. So Hide My Email never
    arises. The server keeps Apple's user id (`sub`) and the refresh token of each
    Apple sign-in, since each stays valid, only to revoke them when the account is deleted, which
    Apple asks of an app that deletes accounts. A revocation Apple fails is retried for about 3
    days, the tokens kept under no account meanwhile, so a deletion never waits on Apple (#1746). `/privacy` says so, and names Apple among who else sees what (#1640).
  - An Apple id no account holds makes a new account, as a new GitHub id does; accounts are not
    linked. Each signs in with its own provider everywhere, so nothing needs linking, and a
    GitHub user who taps Apple by mistake gets an empty account that Delete account removes.
  - The iPhone signs in natively (AuthenticationServices), with a nonce Apple puts in the
    identity token and an authorization code the server trades once, so a token caught on its
    way is worthless (PROTOCOL.md, "Auth").
  - The server fetches Apple's keys at most once a minute, and refuses a key id the last fetch
    lacked until then, so tokens naming made-up keys cannot make it call Apple on every attempt
    (#1739).
- The owner can pause sign-ups (#784), for a launch-day flood or a box near its limits: a GitHub
  user with no account gets "not taking new accounts right now" on the page and in the app, while
  every existing account signs in as before. `bun server.js signups pause|resume` writes and
  removes a file beside the database, which the server reads on each new account, so it takes
  effect at once and survives restarts and deploys.
- A server can list who may sign up (#1524): with `SIGNUP_GITHUB_IDS` set, only those GitHub
  users can make an account (no Apple account is made beside it), so the staging server takes no
  strangers; `OWNER_TOKEN`, a secret its operator sets, still makes the owner account (#1621),
  which staging's app check uses (`spec/releases.md`). A value that is not a list of ids stops the
  server. Others get the paused sign-ups' 403 `signups-paused`, which every client already shows as "no new accounts here",
  so no client changed.
- The page shows only the sign-in methods its server offers (#670): `GET /v1/auth/methods` lists
  them, and without GitHub the landing page's and sign-in page's buttons open the owner token
  form. Until the server answers, the page shows GitHub, the hosted server's, so the landing
  page's HTML keeps its buttons.
- Android (#34, #527): the app signs in with PKCE, and GitHub binds its code to the app's
  challenge, so only the app holding the verifier can trade the code, whoever catches the
  redirect. The server does not rely on GitHub alone (#1719, from an internal audit on
  2026-10-14): a code that comes back through its callback is kept with the challenge it came
  with, and the trade refuses any other verifier, so a code caught after the server passed it on
  is worthless. A code a verified App Link caught never reaches the server, and only GitHub
  checks it. Known gap: a hostile app can start its own sign-in, and if GitHub skips the consent
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
- **Cookies and sign-ins in flight** (#2186, from the security audit of 2026-10-20). On https
  the session and sign-in state cookies are `__Host-` names, which only this very host can set:
  a page on a sibling subdomain (stats.starbridge.run runs third-party code) could otherwise set
  a session cookie for the parent domain and sign the owner's browser into another account. A
  session from before keeps working: a bare `sb_session` counts only without a `__Host-` one
  and moves to it on its first request, so nobody signs in again. The app sign-ins in progress
  are kept per address, 50 an IPv4 address or IPv6 /48, and a full table drops the oldest entry
  of the address that keeps most, never one of an address keeping 5 or fewer, so a flood needs
  thousands of addresses to fail app sign-ins and never drops a person's code in flight. Signing out drops the device's push subscriptions with its last session.
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
