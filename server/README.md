# server

The Starbridge server: Hono on Bun with `bun:sqlite`. It stores the signed directory and sealed
items, and relays pushes; it holds no key that opens anything. Routes: `PROTOCOL.md`.

```bash
pnpm --filter @starbridge/server test
```

```bash
OWNER_TOKEN=change-me PORT=8080 bun run server/src/main.ts
```

## Docker

One image serves the hosted server, self-hosters and the push relay.

```bash
docker build -f server/Dockerfile -t starbridge-server .
```

```bash
docker run -p 8080:8080 -v starbridge:/data -e OWNER_TOKEN=change-me starbridge-server
```

## Environment

| Variable | Default | What |
|---|---|---|
| `PORT` | 8080 | |
| `DB_PATH` | `./data/starbridge.db` (`/data/starbridge.db` in the image) | SQLite file |
| `PUBLIC_URL` | `http://localhost:$PORT` | origin for OAuth redirects and the cross-site check; `https://` makes the cookie Secure |
| `TRUST_PROXY` | off | read the client IP from the last `X-Forwarded-For` hop (behind Caddy) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | GitHub sign-in; callback `$PUBLIC_URL/v1/auth/github/callback` |
| `OWNER_TOKEN` | unset | self-hosted sign-in to the server's one account |
| `APP_REDIRECT_URI` | `starbridge://auth` | where GitHub sign-in sends the Android app |
| `MAX_MACHINES` | 5 | machines per account |
| `MAX_WAIT_SECONDS` | 300 | cap on `wait` for the answer and pairing long-polls |
| `PUSH_INLINE_LIMIT` | 3072 | largest push payload that carries the box |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | unset | Firebase service account; without them FCM goes through the relay |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | unset | Web Push keys (`bunx web-push generate-vapid-keys`); without them Web Push goes through the relay |
| `RELAY_URL` | unset | the relay's origin |
| `RELAY_MODE` | off | serve `POST /v1/relay` for other servers |
| `PUSH_TIMEOUT_MS` | 10000 | give up on one request to a push service after this long |
| `ALLOW_PRIVATE_PUSH_ENDPOINTS` | off | allow push endpoints on private addresses and plain HTTP, for a self-hosted ntfy |
