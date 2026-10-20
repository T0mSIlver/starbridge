# deploy

The hosted instance at https://starbridge.run: `starbridge-1`, a Hetzner CX23 on Ubuntu 26.04.
Docker Compose runs the server, with `RELAY_MODE` on so the
same process is the push relay, and the web page, both behind Caddy, which gets the TLS
certificate. Caddy sends `/v1/*` and `/healthz` to the server and everything else to the page,
so both share one origin.

Log in as `deploy` with `~/.ssh/starbridge_ed25519` and use `sudo`; root login and passwords
are off.

## Deploy

Every push to main goes to staging once CI passes (`.github/workflows/deploy.yml`, and "Staging"
below). starbridge.run takes a commit by dispatch only: `release.yml` sends each rc tag's commit,
and a hotfix is `gh workflow run deploy.yml -f sha=<commit>`; either way the commit must have
passed on staging (its `staging` status). Actions logs in as
`deploy` with its own key (secret `DEPLOY_SSH_KEY`), whose forced command runs
`/usr/local/sbin/starbridge-deploy <commit>` (`host/deploy-rev.sh`) and nothing else. That script
fetches main from GitHub with a read-only deploy key and deploys only main's head, or a commit on
main that contains the deployed one, so the Actions deploy key cannot roll back (Rollback, below,
has its own key), and only once staging
passed it: it reads the commit's `staging` status and the deploy.yml run behind it from GitHub's
public API, without a token, so the Actions key cannot skip staging either. It unpacks the commit
and runs `host/apply.sh`. Once the box runs the commit, the workflow asks sb-oracle for one
round trip on the outside check's test account (secrets `SMOKE_SSH_KEY`, `SMOKE_KNOWN_HOSTS`,
`SMOKE_SSH_TARGET`; the key's forced command runs nothing else). `deploy/setup-actions-deploy.sh` installs both keys
on the box; the private halves stay in `~/.config/starbridge/secrets`.

Both boxes run the same scripts: `host/apply.sh`, `host/deploy-rev.sh` and `host/server-env.sh`
on the box, `push-secrets.sh` and `setup-actions-deploy.sh` from the owner's machine. What
differs between them is a file of settings each, `host/prod.env` and `staging/staging.env`: names
and paths, which check a commit must pass, staging's round trip and demo server, prod's backups,
Umami, denylist and two copies of the page. The deploy command on each box carries a copy of its
settings ahead of `host/deploy-rev.sh`. `deploy/test/trace.sh <commit>` runs both boxes' deploys
of that commit and of the working tree with every outside command stubbed, in a throwaway mount
namespace, and diffs the commands they run: a change to these scripts shows there what it changes
on each box.

To deploy a commit by hand, from the operator's machine:

```bash
deploy/deploy.sh                 # origin/main
```

It unpacks the ref into `/opt/starbridge`, pulls the server and web images for that commit from
ghcr.io and rolls them out (`deploy/host/apply.sh`). It is the owner's way around the checks
above: any pushed commit with images deploys, staging or not. The previous release stays in
`/opt/starbridge.old`.

`deploy.yml` builds those images once per deployed commit, for amd64 and arm64, and pushes them as
`ghcr.io/t0msilver/starbridge-server:<commit>` and `starbridge-web:<commit>`; the box never builds
them. Each box runs them by digest (`host/images.sh`, written to `deploy/.env`): staging the
digests the tag gave it, prod those staging ran, which `starbridge-deploy` reads from staging's
run, so a tag pushed again after staging changes nothing on prod. `deploy.sh` takes the tag. So only commits that `deploy.yml` deployed can be deployed again. The box keeps the newest 5
releases' images. Caddy's image is still built on the box.

## Rollback

From Actions, to a commit the box ran before (#1828):

```bash
gh workflow run rollback.yml -f target=starbridge.run -f sha=<commit>
gh workflow run rollback.yml -f target=staging -f sha=<commit>
```

Each box records every commit it ran, one per line, newest last: `sudo cat
/var/lib/starbridge/deployed` on prod, `/var/lib/starbridge-staging/deployed` on sb-staging. The
workflow logs in with the environment's `ROLLBACK_SSH_KEY`, whose forced command runs only
`starbridge-deploy --rollback <commit>`. That refuses a commit the box never ran or one not on
main, and on prod one staging never passed; it deploys the commit's whole tree with the image
digests staging ran, then the workflow checks `/healthz` names it and, on prod, runs the outside
round trip. The deploy key still cannot roll back.

Setting up a box's rollback key, once, from the owner's machine:

```bash
ssh-keygen -t ed25519 -N '' -C starbridge-actions-rollback -f /tmp/rollback-key
gh secret set ROLLBACK_SSH_KEY --env starbridge.run < /tmp/rollback-key   # --env staging for staging
deploy/setup-actions-rollback.sh prod /tmp/rollback-key.pub               # staging for staging
shred -u /tmp/rollback-key /tmp/rollback-key.pub
```

The private half goes only to the secret. The key works once the box runs a `deploy-rev.sh` with
`--rollback`, which every deploy installs, and the record starts with the first deploy by that
script, which also records the commit it replaces.

From the owner's machine, with the full-sudo key, to a release whose images the box holds:

```bash
deploy/rollback.sh --list        # the releases whose images the box holds, newest first
deploy/rollback.sh               # back to the one before the running release
deploy/rollback.sh <commit>      # back to that one
```

It shows both releases and asks, then deploys the older commit's whole tree with `deploy.sh`,
skipping every check above. Either way, a rollback past a release that migrated
the database stops before anything changes (see Restore). The next deploy goes forward again, so
revert the bad commit first. Rolling back the apps, npm and Homebrew is a checklist in
`spec/releases.md`.

No request fails during a deploy (`spec/releases.md`). The page runs as two copies, `web-a` (port
3010) and `web-b` (3011): the deploy starts the idle one, waits for its health, then stops the
other, and Caddy sends requests to the first healthy copy. The server restarts in place; Caddy
holds requests for up to 30 s meanwhile. Each deploy loads the Caddyfile into the running Caddy
through its admin API (`host/caddy-load.sh`), on a socket only root can open,
`/run/starbridge-caddy/admin.sock`. Caddy's container is recreated, which drops every
open connection, only when its definition in `compose.yaml` or `caddy.Dockerfile` changes: its
image is tagged by a hash of that file and built only when no image has the tag.

## Staging

`https://staging.starbridge.run` runs on sb-staging, an Oracle ARM VM, from every deploy of
main: the same images as prod, prod's compose file with `staging/compose.yaml` laid over it, and
prod's Caddyfile under staging's host name with `X-Robots-Tag: noindex`. It has its own secrets
and no Umami or backups; the Play demo server runs beside it (below). `deploy.yml`'s staging key runs only
`starbridge-staging-deploy <commit>` (`host/deploy-rev.sh` with `staging/staging.env`), which fetches main over HTTPS,
checks from GitHub's public API that CI passed the commit on main, runs `host/apply.sh` (through `staging/apply.sh`), then one round trip on staging's test account through the outside
check's staging instance on the VM (`sb-check-now /var/lib/sb-check-staging`). Prod's deploy
waits for that job and runs only when it passed.

| What | How |
|---|---|
| Set up | The VM comes with Docker, git, curl, jq and its firewall from the homelab. `deploy/setup-actions-deploy.sh staging` installs the deploy command and the Actions key; `deploy/push-secrets.sh staging` copies the secrets in `~/.config/starbridge/secrets/staging` (`github-oauth-client-id`, `github-oauth-client-secret` of the "Starbridge staging" OAuth app, `vapid-public-key`, `vapid-private-key`, `signup-github-ids`, `owner-token`) |
| Who can sign in | Only the GitHub ids in `signup-github-ids` can make an account (`SIGNUP_GITHUB_IDS`), and the holder of `owner-token` (`OWNER_TOKEN`) the owner account, which only the app check uses (`staging-app.yml`) |
| Data | Synthetic only: `deploy/staging/seed.sh 200` makes 200 users through the real sign-in and pairing flows (`evals/load/setup.ts`), with staging's server stopped meanwhile. Nothing is backed up: the seed is the backup |
| Compose project | `sudo docker compose -p starbridge-staging -f /opt/starbridge-staging/deploy/compose.yaml -f /opt/starbridge-staging/deploy/staging/compose.yaml` |

## First setup

1. As root: `ssh root@starbridge.run sh -s < deploy/host/setup.sh`. It installs Docker, git,
   sqlite3 and unattended-upgrades (with reboots at 04:00), adds `deploy` with root's SSH keys,
   and turns password login, agent forwarding and every TCP forward but the one to Umami's
   dashboard off. Once it has checked that `deploy` can log in and use sudo, it lets only
   `deploy` log in. Keep that session open until `ssh deploy@starbridge.run sudo true`
   works from a second terminal; if `deploy` breaks, Hetzner's rescue system still reaches the box. Run it again later
   as `ssh deploy@starbridge.run sudo sh -s < deploy/host/setup.sh`.
2. `deploy/push-secrets.sh` copies the secrets from `~/.config/starbridge/secrets` to
   `/etc/starbridge/secrets` (root, 0700); given names, only those. `deploy/host/server-env.sh`
   and `caddy-auth.sh` turn them into what the containers read on every deploy. The iPhone
   app's APNs key is optional until it ships: `apns-key.p8` (the key Apple gives once) and
   `apns-key-id` (its 10-character id) become `APNS_PRIVATE_KEY` and `APNS_KEY_ID`, with the
   team id and bundle id set in `server-env.sh`. Without them, iPhone pushes go nowhere and their
   subscriptions stay. The Sign in with Apple key is optional too: `apple-signin-key.p8` and
   `apple-signin-key-id` become `APPLE_PRIVATE_KEY` and `APPLE_KEY_ID`; without them the server
   offers no Apple sign-in.
3. `deploy/deploy.sh`.
4. `deploy/setup-actions-deploy.sh` for deploys from Actions.

## On the box

| What | Where |
|---|---|
| Compose project | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml` |
| Database | volume `starbridge_data`, `/data/starbridge.db` in the container |
| Backups | `/var/backups/starbridge/starbridge-YYYYMMDD.db` and `umami-YYYYMMDD.dump`, nightly at 03:15 UTC, 7 days; `deploy-*.db`, the last 2 deploys that ran a migration; both are `VACUUM INTO` copies. Hetzner backups cover the rest |
| Offsite backup | After each nightly backup, `starbridge-offsite.service` (`host/offsite.sh`) compresses the new copy, encrypts it with `age` to the owner's key, whose private half is on neither server, and pushes it over SSH to a host that only takes new files, which keeps 14 days (#1482). It needs `backup-age.pub`, `offsite-ssh-key`, `offsite-known-hosts` and `offsite-target` from `push-secrets.sh`; without them it does nothing |
| Docker prune | `starbridge-docker-prune.timer`, Sundays at 04:30 UTC: images no container uses and build cache, older than 7 days, except the server and web images, of which each deploy keeps the newest 5 |
| Analytics | Umami (`umami`, `umami-db`), volume `starbridge_umami-db`; secrets in `/etc/starbridge/umami.env` and `umami-db.env`, made on the first deploy |
| Analytics limits | Caddy (built with the `rate_limit` module, `caddy.Dockerfile`) takes 30 events a minute per address and 300 in all, 8 KB each; `starbridge-umami-trim.timer` keeps each table to 180 days and a million rows, hourly |
| Uptime | `.github/workflows/uptime.yml` checks `/healthz`, `/healthz/backup` (503 once the last backup is over 26 h old) and `/healthz/disk` (503 under 2 GB free) hourly and opens an `outage` issue on failure |
| FCM check | `sudo /opt/starbridge/deploy/host/check-fcm.sh` mints a token with the service account |
| Launch watch | `bun deploy/watch/watch.ts` from the operator's machine: one report and a JSON line, exit 1 on a new alert (`deploy/watch/thresholds.ts`). It runs `host/watch.sh` over SSH, which changes nothing. `bun server.js top 10` in the server container lists the accounts holding and posting the most |
| Response switches | `deploy/switch.sh` from the operator's machine runs `host/switch.sh` on the box; each change is a line in `/var/log/starbridge/switches.log`. `deploy/switch.sh block 198.51.100.7` (or a CIDR; an IPv6 address counts as its /64) adds it to `/etc/starbridge/caddy/denylist` and reloads Caddy, which answers it 403 on every host but stats; `unblock` takes it out; `blocked` lists them. No restart, so no connection drops |
| Sign-ups | `deploy/switch.sh signups pause`, `resume` or `status` (#784): while paused, GitHub users with no account are refused with a message; existing accounts sign in as before |
| Suspend an account | `deploy/switch.sh suspend ACCOUNT` and `unsuspend ACCOUNT` (#785): its machines' writes get 403 `account-suspended`; its phones and browsers work as before. Account ids come from `bun server.js top` |
| Empty an account | `deploy/switch.sh purge ACCOUNT` (#1736): deletes every item it stores, a batch at a time while the server runs, and frees the server's storage; the account and its devices stay. Suspend it first if its machines would post again |
| Limits at runtime | `deploy/switch.sh limits set items 60/60` (calls per seconds for a rate window, a whole number for a cap, `maxMachines` for the machine cap), `limits unset items`, `limits reset`, `limits show` (#786). The server applies a change within a minute; the names are those in `server/src/limits.ts`, retention periods excepted |
| Usage counts | `sudo docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml exec server bun server.js usage 14` prints the last 14 days (`server/src/usage.ts`) |

## Analytics

Umami counts visits to the public pages (`spec/hosted.md`). Its dashboard listens on
the box's `127.0.0.1:3001` only:

```bash
ssh -i ~/.ssh/starbridge_ed25519 -N -L 3001:127.0.0.1:3001 deploy@starbridge.run
```

then open `http://localhost:3001` and log in as `admin` with the password in
`~/.config/starbridge/secrets/umami-admin-password`. After the first deploy with Umami, run
`deploy/umami-setup.sh` once, and again when its funnels change: it sets that password and adds the website, the funnels and
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

`https://demo.starbridge.run` lets Play reviewers try the app (`spec/hosted.md`): the server with
`DEMO=1` and the demo program (`demo/`) in one container, Compose project `starbridge-demo`, on
sb-staging's `127.0.0.1:8090`, behind staging's Caddy (`demo/demo.caddy`). Its account outlasts
restarts and redeploys on the project's `data` volume; the Logs command below with `down -v` in
place of `logs` drops it, and `setup.sh` then starts a fresh account. Each staging deploy whose
round trip passed rebuilds it from that checkout (`deploy/host/demo.sh`), and restarts it only when its image changed; a failed demo
deploy is printed but blocks nothing. `deploy/demo/setup.sh` gives it its owner token from
`~/.config/starbridge/secrets/demo-owner-token`, and starts it. Logs:
`ssh sb-staging sudo docker compose -p starbridge-demo -f /opt/starbridge-staging/deploy/demo/compose.yaml logs`
shows each join it approved.
