# deploy

The hosted instance at https://starbridge.run: `starbridge-1`, a Hetzner CX23 on Ubuntu 26.04.
Docker Compose runs the server, with `RELAY_MODE` on so the
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

No request fails during a deploy (`SPEC.md`, "Releases, deploys and CI"). The page runs as two copies, `web-a` (port
3010) and `web-b` (3011): the deploy starts the idle one, waits for its health, then stops the
other, and Caddy sends requests to the first healthy copy. The server restarts in place; Caddy
holds requests for up to 30 s meanwhile. Each deploy loads the Caddyfile into the running Caddy
through its admin API on `127.0.0.1:2019`. Caddy's container is recreated, which drops every
open connection, only when its definition in `compose.yaml` or `caddy.Dockerfile` changes: its
image is tagged by a hash of that file and built only when no image has the tag.

## First setup

1. As root: `ssh root@starbridge.run sh -s < deploy/host/setup.sh`. It installs Docker, git,
   sqlite3 and unattended-upgrades (with reboots at 04:00), adds `deploy`, and turns password
   login off.
2. From a second terminal, check that `ssh deploy@starbridge.run sudo true` works, then
   `ssh deploy@starbridge.run sudo sh -s < deploy/host/lock-root.sh` turns root login off.
3. `deploy/push-secrets.sh` copies the secrets from `~/.config/starbridge/secrets` to
   `/etc/starbridge/secrets` (root, 0700); given names, only those. `deploy/host/server-env.sh`
   and `caddy-auth.sh` turn them into what the containers read on every deploy.
4. `deploy/deploy.sh`.
5. `deploy/setup-actions-deploy.sh` for deploys from Actions.

## On the box

| What | Where |
|---|---|
| Compose project | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml` |
| Database | volume `starbridge_data`, `/data/starbridge.db` in the container |
| Backups | `/var/backups/starbridge/starbridge-YYYYMMDD.db` and `umami-YYYYMMDD.dump`, nightly at 03:15 UTC, 7 days; `deploy-*.db`, the last 2 deploys that ran a migration; both are `VACUUM INTO` copies. Hetzner backups cover the rest |
| Docker prune | `starbridge-docker-prune.timer`, Sundays at 04:30 UTC: images no container uses and build cache, older than 7 days |
| Analytics | Umami (`umami`, `umami-db`), volume `starbridge_umami-db`; secrets in `/etc/starbridge/umami.env` and `umami-db.env`, made on the first deploy |
| Analytics limits | Caddy (built with the `rate_limit` module, `caddy.Dockerfile`) takes 30 events a minute per address and 300 in all, 8 KB each; `starbridge-umami-trim.timer` keeps each table to 180 days and a million rows, hourly |
| Uptime | `.github/workflows/uptime.yml` checks `/healthz`, `/healthz/backup` (503 once the last backup is over 26 h old) and `/healthz/disk` (503 under 2 GB free) hourly and opens an `outage` issue on failure |
| FCM check | `sudo /opt/starbridge/deploy/host/check-fcm.sh` mints a token with the service account |
| Launch watch | `bun deploy/watch/watch.ts` from the operator's machine: one report and a JSON line, exit 1 on a new alert (`deploy/watch/thresholds.ts`). It runs `host/watch.sh` over SSH, which changes nothing. `bun server.js top 10` in the server container lists the accounts holding and posting the most |
| Response switches | `deploy/switch.sh` from the operator's machine runs `host/switch.sh` on the box; each change is a line in `/var/log/starbridge/switches.log`. `deploy/switch.sh block 198.51.100.7` (or a CIDR; an IPv6 address counts as its /64) adds it to `/etc/starbridge/caddy/denylist` and reloads Caddy, which answers it 403 on every host but stats; `unblock` takes it out; `blocked` lists them. No restart, so no connection drops |
| Sign-ups | `deploy/switch.sh signups pause`, `resume` or `status` (#784): while paused, GitHub users with no account are refused with a message; existing accounts sign in as before |
| Limits at runtime | `deploy/switch.sh limits set items 60/60` (calls per seconds for a rate window, a whole number for a cap, `maxMachines` for the machine cap), `limits unset items`, `limits reset`, `limits show` (#786). The server applies a change within a minute; the names are those in `server/src/limits.ts`, retention periods excepted |
| Usage counts | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml exec server bun server.js usage 14` prints the last 14 days (`server/src/usage.ts`) |

## Analytics

Umami counts visits to the public pages (`SPEC.md`, "The hosted instance"). Its dashboard listens on
the box's `127.0.0.1:3001` only:

```bash
ssh -i ~/.ssh/starbridge_ed25519 -N -L 3001:127.0.0.1:3001 deploy@starbridge.run
```

then open `http://localhost:3001` and log in as `admin` with the password in
`~/.config/starbridge/secrets/umami-admin-password`. After the first deploy with Umami, run
`deploy/umami-setup.sh` once: it sets that password and adds the website, the launch funnel and
a share link on `stats.starbridge.run`, which it prints. That host serves only the share page
(`Caddyfile`); its DNS records point at the box like the main domain's. It asks for a password
too, user `tom`, then sets a cookie that the page's API calls carry instead (Umami's page replaces
the browser's saved password with its own header): the password is in `~/.config/starbridge/secrets/stats-password` and its bcrypt
hash in `stats-password-hash` beside it. To change it, write a new password there, hash it with
`caddy hash-password --bcrypt-cost 10` into `stats-password-hash` (a higher cost lets anyone
spend the box's CPU), run `deploy/push-secrets.sh stats-password-hash` and deploy. Until a deploy
has run with the hash on the box, the host turns everyone away. To leave your own
visits out, run `localStorage.setItem("umami.disabled", "1")` in the browser's console on
starbridge.run.

## Restore

To restore, stop the server, copy a backup over `starbridge.db` in the volume, delete
`starbridge.db-wal` and `starbridge.db-shm`, `chown 1000:1000` it and start the server. Besides
the nightly `starbridge-YYYYMMDD.db`, each deploy that runs a migration leaves `deploy-<time>.db`, taken while
the old server still ran, seconds before the new one opened the database; the last two are kept.

A server refuses a database whose schema is newer than its own (`PRAGMA user_version`), and
`apply.sh` stops such a deploy before it replaces anything, so rolling back past a release that
migrated fails: restore that deploy's `deploy-<time>.db` along with the rollback.

To restore Umami, stop `umami`, then
`sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml exec -T umami-db pg_restore -U umami -d umami --clean < umami-YYYYMMDD.dump`
and start `umami`.

## Demo server

`https://demo.starbridge.run` lets Play reviewers try the app (`SPEC.md`, "The hosted instance"): the server with
`DEMO=1` and the demo program (`demo/`) in one container, Compose project `starbridge-demo`, on
`127.0.0.1:8090`, with no volume, so each restart is a fresh account. Prod's Caddy serves it.
`deploy/demo/deploy.sh [ref]` deploys it from the operator's machine, with the owner token from
`~/.config/starbridge/secrets/demo-owner-token`; it never touches prod's project or data.
`sudo docker compose -p starbridge-demo -f /opt/starbridge-demo/deploy/demo/compose.yaml logs`
shows each join it approved.
