# web

The Starbridge web page: Next.js on Bun. It is a device like the Android app. It makes its own
keys, verifies the directory on every load, and opens decisions and quota snapshots in the browser
and in the service worker. The server sees public keys and ciphertext only.

## Run it against a local server

The page must share the server's origin: the session cookie is `SameSite=Lax`, and the server
refuses cross-origin writes. Next proxies `/v1` to `STARBRIDGE_SERVER`, so the server's
`PUBLIC_URL` is the page's origin.

```bash
PUBLIC_URL=http://localhost:3000 OWNER_TOKEN=change-me PORT=8080 bun run server/src/main.ts
```

```bash
STARBRIDGE_SERVER=http://localhost:8080 pnpm --filter @starbridge/web dev
```

Open port 3000 and sign in with the owner token. In production a reverse proxy routes `/v1` to
the server and everything else to this app.

## Keys

Where the browser has X25519 and Ed25519 in WebCrypto, the private keys are non-extractable
`CryptoKey`s in IndexedDB: page scripts can use them but never read them. Opening a sealed box
then runs the X25519 step in WebCrypto and the rest with libsodium (`src/lib/crypto/keys.ts`).
Other browsers fall back to raw libsodium keys in IndexedDB. libsodium and the protocol code load
after the first paint.

## Service worker

`bun run sw` bundles `src/sw/sw.ts` to `public/sw.js`; `dev` and `build` run it first. The worker
opens each Web Push payload, verifies it against the pinned directory, and shows the decision with
its options as notification actions when the browser can show all of them.

## End-to-end run

`e2e/run.ts` starts the server, this app (built), stand-ins for GitHub and for a Web Push service
(`e2e/services.ts`), and drives Firefox through GitHub sign-in, first-device setup, Web Push, a
`starbridge pair` approval and a refusal, `starbridge quota push`, answering `starbridge ask
--wait`, a second browser by pairing code, a third by the recovery words, a revoke, and a
sign-in again that binds the new session to the existing device. It writes
the screenshots in `screenshots/`. Ports 3870 to 3873 on localhost.

```bash
npx playwright install firefox
```

```bash
xvfb-run -a node web/e2e/run.ts
```

It runs headed because headless Firefox cannot show notifications. With `codexbar` on the PATH the
quota step uploads real windows; without it, the CLI's recorded fixtures.

## Installed app check

`e2e/install.ts` checks the installed app without an iPhone or a desktop install: WebKit as an
iPhone shows the Add to Home Screen step in a tab and not in the Home Screen app, and Chromium
runs its installability check on the manifest, installs the page and launches it in its own
window. It writes the screenshots in `docs/install/`. Ports 3880 and 3881 on localhost.

```bash
npx playwright install webkit chromium && sudo npx playwright install-deps webkit
```

```bash
xvfb-run -a -s "-screen 0 1280x860x24" node web/e2e/install.ts
```
