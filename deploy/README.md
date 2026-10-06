# deploy

The hosted instance at https://starbridge.run: `starbridge-1`, a Hetzner CX23 on Ubuntu 26.04
(accounts in `SPEC.md`, "Accounts"). Docker Compose runs the server, with `RELAY_MODE` on so the
same process is the push relay, and the web page, both behind Caddy, which gets the TLS
certificate. Caddy sends `/v1/*` and `/healthz` to the server and everything else to the page,
so both share one origin.

Log in as `deploy` with `~/.ssh/starbridge_ed25519` and use `sudo`; root login and passwords
are off.

## Deploy

Every push to main deploys once CI passes (`.github/workflows/deploy.yml`). Actions logs in as
`deploy` with its own key (secret `DEPLOY_SSH_KEY`), whose forced command runs
`/usr/local/sbin/starbridge-deploy <commit>` (`host/deploy-rev.sh`) and nothing else. That script
fetches main from GitHub with a read-only deploy key and deploys only main's head, or a commit on
main that contains the deployed one, so the Actions key cannot roll back. It unpacks the commit
and runs `host/apply.sh`. `deploy/setup-actions-deploy.sh` installs both keys
on the box; the private halves stay in `~/.config/starbridge/secrets`.

To roll back, or to deploy a branch, from the operator's machine with any ref that is on GitHub:

```bash
deploy/deploy.sh                 # origin/main
```

It unpacks the ref into `/opt/starbridge`, builds the server and web images on the box and rolls them
out (`deploy/host/apply.sh`). The previous release stays in `/opt/starbridge.old`.

No request fails during a deploy (`SPEC.md`, #150). The page runs as two copies, `web-a` (port
3010) and `web-b` (3011): the deploy starts the idle one, waits for its health, then stops the
other, and Caddy sends requests to the first healthy copy. The server restarts in place; Caddy
holds requests for up to 30 s meanwhile. Each deploy loads the Caddyfile into the running Caddy
through its admin API on `127.0.0.1:2019`.

## First setup

1. As root: `ssh root@starbridge.run sh -s < deploy/host/setup.sh`. It installs Docker, git,
   sqlite3 and unattended-upgrades (with reboots at 04:00), adds `deploy`, and turns password
   login off.
2. From a second terminal, check that `ssh deploy@starbridge.run sudo true` works, then
   `ssh deploy@starbridge.run sudo sh -s < deploy/host/lock-root.sh` turns root login off.
3. `deploy/push-secrets.sh` copies the secrets from `~/.config/starbridge/secrets` to
   `/etc/starbridge/secrets` (root, 0700). `deploy/host/server-env.sh` turns them into
   `/etc/starbridge/server.env` on every deploy.
4. `deploy/deploy.sh`.
5. `deploy/setup-actions-deploy.sh` for deploys from Actions.

## On the box

| What | Where |
|---|---|
| Compose project | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml` |
| Database | volume `starbridge_data`, `/data/starbridge.db` in the container |
| Backups | `/var/backups/starbridge/starbridge-YYYYMMDD.db` and `umami-YYYYMMDD.dump`, nightly at 03:15 UTC, 14 days; Hetzner backups cover the rest |
| Analytics | Umami (`umami`, `umami-db`), volume `starbridge_umami-db`; secrets in `/etc/starbridge/umami.env` and `umami-db.env`, made on the first deploy |
| Analytics limits | Caddy (built with the `rate_limit` module, `caddy.Dockerfile`) takes 30 events a minute per address and 300 in all, 8 KB each; `starbridge-umami-trim.timer` keeps each table to 180 days and a million rows, hourly |
| Uptime | `.github/workflows/uptime.yml` checks `/healthz` and `/healthz/backup` (503 once the last backup is over 26 h old) hourly and opens an `outage` issue on failure |
| FCM check | `sudo /opt/starbridge/deploy/host/check-fcm.sh` mints a token with the service account |
| Usage counts | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml exec server bun server.js usage 14` prints the last 14 days (`server/src/usage.ts`) |

## Analytics

Umami counts visits to the public pages (`SPEC.md`, "Page analytics"). Its dashboard listens on
the box's `127.0.0.1:3001` only:

```bash
ssh -i ~/.ssh/starbridge_ed25519 -N -L 3001:127.0.0.1:3001 deploy@starbridge.run
```

then open `http://localhost:3001` and log in as `admin` with the password in
`~/.config/starbridge/secrets/umami-admin-password`. After the first deploy with Umami, run
`deploy/umami-setup.sh` once: it sets that password and adds the website. To leave your own
visits out, run `localStorage.setItem("umami.disabled", "1")` in the browser's console on
starbridge.run.

## Restore

To restore, stop the server, copy a backup over `starbridge.db` in the volume, delete
`starbridge.db-wal` and `starbridge.db-shm`, `chown 1000:1000` it and start the server.

To restore Umami, stop `umami`, then
`sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml exec -T umami-db pg_restore -U umami -d umami --clean < umami-YYYYMMDD.dump`
and start `umami`.
