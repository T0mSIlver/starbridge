# Self-host

Run your own Starbridge server instead of starbridge.run. The server is one Bun process and a
SQLite file. It stores encrypted items and relays notifications; it holds no key that opens
them. Its routes are in `PROTOCOL.md`.

## What you run

- The server, which answers `/v1/*` and `/healthz`.
- The web app, which serves every other path.
- A reverse proxy in front of both, on one origin, such as `https://starbridge.example`. The
  session cookie and the server's cross-site check need the API and the web app on the same
  origin.

## Set it up

1. With Docker installed, clone the latest release of this repository (replace `v0.1.0` with
   its tag) and build the two images:

   ```bash
   git clone --branch v0.1.0 https://github.com/T0mSIlver/starbridge
   cd starbridge
   docker build -f server/Dockerfile -t starbridge-server .
   docker build -f web/Dockerfile -t starbridge-web .
   ```

2. Start the server. Pick a long random owner token; it signs you in to the server's one
   account.

   ```bash
   docker run -d -p 8080:8080 -v starbridge:/data \
     -e OWNER_TOKEN=change-me \
     -e PUBLIC_URL=https://starbridge.example \
     -e RELAY_URL=https://starbridge.run \
     -e TRUST_PROXY=1 \
     starbridge-server
   ```

3. Start the web app:

   ```bash
   docker run -d -p 3000:3000 starbridge-web
   ```

4. Route both through your reverse proxy. With Caddy, which also gets the TLS certificate:

   ```caddyfile
   starbridge.example {
     # The web image sets the page's Content-Security-Policy; the proxy sets the rest.
     header {
       Strict-Transport-Security "max-age=31536000"
       X-Content-Type-Options nosniff
       Referrer-Policy same-origin
       defer
     }
     @server path /v1/* /healthz /healthz/*
     handle @server {
       reverse_proxy localhost:8080
     }
     handle {
       reverse_proxy localhost:3000
     }
   }
   ```

5. Sign in. On the web, open your origin and pick "Use your own server" under "Continue with
   GitHub". In the Android app, pick "Use your own server" and enter your origin. Both ask for
   the owner token. With [GitHub sign-in](#sign-in) set up, the app and the web page can use it
   on your server too.

6. Pair each machine that runs agents with your server:

   ```bash
   starbridge setup --server https://starbridge.example
   ```

   Or set `STARBRIDGE_SERVER` before you run `starbridge pair`.

## Notifications

Android notifications go through Firebase, whose credentials belong to the app's project. With
`RELAY_URL=https://starbridge.run`, your server sends them through the hosted relay, which sees
only ciphertext and ids. To keep Google out, use UnifiedPush with ntfy or another distributor;
the server pushes to it directly.

Web Push also goes through the relay unless you set your own VAPID keys.

Without the relay or UnifiedPush, the Android app gets no pushes: while it is open it checks for
new items every 10 seconds, and nothing reaches the phone while it is closed. The web page still
updates on its own. For notifications on Android, set `RELAY_URL`, or install a UnifiedPush
distributor such as ntfy and pick UnifiedPush in the app under Settings → Notifications →
Delivered through. For an ntfy on your own network or on plain HTTP, set
`ALLOW_PRIVATE_PUSH_ENDPOINTS=1`.

## Upgrade

A new server brings its database's schema up to date when it starts. Copy the database first,
with the server running:

```bash
sudo sqlite3 "$(docker volume inspect -f '{{.Mountpoint}}' starbridge)/starbridge.db" ".backup 'starbridge-before.db'"
```

A server refuses a database a newer release has already upgraded, so to go back to an older
release, restore the copy you made before upgrading.

## Environment

### Basics

<dl>
<dt><code>PUBLIC_URL</code></dt>
<dd>The origin people open, such as <code>https://starbridge.example</code>. The server uses it for sign-in redirects and the cross-site check, and an <code>https://</code> origin makes the session cookie Secure. Default: <code>http://localhost:$PORT</code>.</dd>
<dt><code>PORT</code></dt>
<dd>Default: 8080.</dd>
<dt><code>DB_PATH</code></dt>
<dd>The SQLite file. Default: <code>./data/starbridge.db</code>, or <code>/data/starbridge.db</code> in the image.</dd>
<dt><code>TRUST_PROXY</code></dt>
<dd>Read the client's IP from the last <code>X-Forwarded-For</code> hop. Turn it on behind a reverse proxy. Default: off.</dd>
</dl>

### Sign-in

<dl>
<dt><code>OWNER_TOKEN</code></dt>
<dd>Signs you in to the server's one owner account. Set it, GitHub sign-in, or both. Unset by default.</dd>
<dt><code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code></dt>
<dd>GitHub sign-in, where each GitHub user gets their own account, from a GitHub OAuth app. Set both. Register two callback URLs in the OAuth app: <code>$PUBLIC_URL/v1/auth/github/callback</code> for the web and <code>$PUBLIC_URL/v1/auth/github/callback/app</code> for the Android app. GitHub refuses the app's sign-in when only the first is listed. Unset by default.</dd>
<dt><code>APP_REDIRECT_URI</code></dt>
<dd>Where GitHub sign-in sends the Android app. Only starbridge.run can vouch for the app, so its server sets <code>https://starbridge.run/app/auth</code>. Default: <code>starbridge://auth</code>.</dd>
</dl>

### Notifications

<dl>
<dt><code>RELAY_URL</code></dt>
<dd>The relay's origin, such as <code>https://starbridge.run</code>. Without it, and without your own Firebase or VAPID keys, Android and Web Push notifications don't go out: the open app and web page still update, the app every 10 s, but nothing reaches a phone whose app is closed. UnifiedPush works without it. Unset by default.</dd>
<dt><code>FCM_PROJECT_ID</code>, <code>FCM_CLIENT_EMAIL</code>, <code>FCM_PRIVATE_KEY</code></dt>
<dd>A service account of the Android app's own Firebase project, which only starbridge.run holds. Self-hosters use the relay or UnifiedPush instead. Unset by default.</dd>
<dt><code>VAPID_PUBLIC_KEY</code>, <code>VAPID_PRIVATE_KEY</code>, <code>VAPID_SUBJECT</code></dt>
<dd>Web Push keys, to send browser notifications without the relay. Make them with <code>bunx web-push generate-vapid-keys</code>. Unset by default.</dd>
<dt><code>ALLOW_PRIVATE_PUSH_ENDPOINTS</code></dt>
<dd>Accept push endpoints on private addresses and plain HTTP, for an ntfy on your own network. Default: off.</dd>
<dt><code>RELAY_MODE</code></dt>
<dd>Serve <code>POST /v1/relay</code> for other servers, as starbridge.run does. Default: off.</dd>
<dt><code>PUSH_TIMEOUT_MS</code></dt>
<dd>How long one request to a push service may take. Default: 10000.</dd>
<dt><code>PUSH_INLINE_LIMIT</code></dt>
<dd>The largest push payload that carries the encrypted item itself; larger ones carry only its id. Default: 3072 bytes.</dd>
</dl>

### Limits

<dl>
<dt><code>MAX_MACHINES</code></dt>
<dd>Machines per account. Default: 5.</dd>
<dt><code>MAX_WAIT_SECONDS</code></dt>
<dd>The longest an answer or pairing long-poll waits. Default: 300.</dd>
</dl>

## Run from source

The server alone, for development; `web/README.md` adds the web app.

```bash
pnpm install
```

```bash
OWNER_TOKEN=change-me PORT=8080 bun run server/src/main.ts
```

```bash
pnpm --filter @starbridge/server test
```

`usage [days]` prints the daily usage counts from `DB_PATH` and exits; the image runs it as
`bun server.js usage`. What it counts: `src/usage.ts` and `/privacy`.

```bash
DB_PATH=./data/starbridge.db bun run server/src/main.ts usage 14
```
