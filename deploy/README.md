# deploy

The hosted instance at https://starbridge.run: `starbridge-1`, a Hetzner CX23 on Ubuntu 26.04
(accounts in `SPEC.md`, "Accounts"). Docker Compose runs the server, with `RELAY_MODE` on so the
same process is the push relay, and the web page, both behind Caddy, which gets the TLS
certificate. Caddy sends `/v1/*` and `/healthz` to the server and everything else to the page,
so both share one origin.

Log in as `deploy` with `~/.ssh/starbridge_ed25519` and use `sudo`; root login and passwords
are off.

## Deploy

From the dev box, any ref that is on GitHub:

```bash
deploy/deploy.sh                 # origin/main
```

It unpacks the ref into `/opt/starbridge`, builds the server and web images on the box and restarts the stack
(`deploy/host/apply.sh`). The previous release stays in `/opt/starbridge.old`.

## First setup

1. As root: `ssh root@starbridge.run sh -s < deploy/host/setup.sh`. It installs Docker,
   sqlite3 and unattended-upgrades (with reboots at 04:00), adds `deploy`, and turns password
   login off.
2. From a second terminal, check that `ssh deploy@starbridge.run sudo true` works, then
   `ssh deploy@starbridge.run sudo sh -s < deploy/host/lock-root.sh` turns root login off.
3. `deploy/push-secrets.sh` copies the secrets from `~/.config/starbridge/secrets` to
   `/etc/starbridge/secrets` (root, 0700). `deploy/host/server-env.sh` turns them into
   `/etc/starbridge/server.env` on every deploy.
4. `deploy/deploy.sh`.

## On the box

| What | Where |
|---|---|
| Compose project | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml` |
| Database | volume `starbridge_data`, `/data/starbridge.db` in the container |
| Backups | `/var/backups/starbridge/starbridge-YYYYMMDD.db`, nightly at 03:15 UTC, 14 days; Hetzner backups cover the rest |
| FCM check | `sudo /opt/starbridge/deploy/host/check-fcm.sh` mints a token with the service account |

To restore, stop the server, copy a backup over `starbridge.db` in the volume, delete
`starbridge.db-wal` and `starbridge.db-shm`, `chown 1000:1000` it and start the server.
