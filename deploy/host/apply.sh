#!/bin/sh
# Run as root on starbridge-1 after deploy.sh has unpacked a release into /opt/starbridge.
set -eu
cd /opt/starbridge/deploy
compose="docker compose -p starbridge -f compose.yaml"
# The commit, built into the server for /healthz. An older starbridge-deploy on the host passes
# none and writes REVISION before this runs.
export REVISION=${REVISION:-$(cat /opt/starbridge/REVISION 2>/dev/null || echo unknown)}

install -m 644 host/starbridge-backup.service host/starbridge-backup.timer \
  host/starbridge-umami-trim.service host/starbridge-umami-trim.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now starbridge-backup.timer starbridge-umami-trim.timer
install -m 755 host/deploy-rev.sh /usr/local/sbin/starbridge-deploy

host/server-env.sh
host/umami-env.sh
host/caddy-auth.sh
$compose build --pull server web-a
# Caddy's image changes only when caddy.Dockerfile does: a new image recreates the container,
# which drops every open connection. Its build is not reproducible (xcaddy fetches and compiles
# afresh once the build cache is pruned), so it is tagged by a hash of the Dockerfile, which pins
# every input, and built only when no image has that tag.
caddy=starbridge-caddy:$(sha256sum caddy.Dockerfile | cut -c1-16)
if ! docker image inspect "$caddy" >/dev/null 2>&1; then
  $compose build caddy
  docker tag starbridge-caddy:latest "$caddy"
fi
docker tag "$caddy" starbridge-caddy:latest

# healthy URL SERVICE [SECONDS]
healthy() {
  for _ in $(seq "${3:-30}"); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$2 not healthy after ${3:-30} s" >&2
  $compose logs --tail 50 "$2" >&2
  return 1
}

# No request fails during a deploy (#150). The page runs as two copies: start the idle one, wait
# for its health, then stop the live one; Caddy sends requests to the first healthy copy.
if [ -n "$($compose ps -q --status running web-a)" ]; then
  live=web-a next=web-b port=3011
else
  live=web-b next=web-a port=3010
fi
$compose up -d --no-deps --force-recreate $next
# A copy that never turns healthy is stopped, so the live one stays the only one running and a
# retried deploy replaces the failed copy, not the live one.
healthy http://127.0.0.1:$port/ $next || { $compose stop $next; exit 1; }

# Caddy takes the Caddyfile through its admin API on every deploy: a reload keeps open
# connections, where recreating the container would drop them, and an unchanged one is a no-op.
# Loading each time, rather than when the file changed, also heals a load that failed before.
$compose up -d caddy
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 -X POST \
  -H 'Content-Type: text/caddyfile' --data-binary @Caddyfile http://127.0.0.1:2019/load
# Caddy checks health every second: let it see the new copy before the old one goes. Requests
# in flight at the stop are GETs, which Caddy retries on the new copy.
sleep 2
$compose stop $live

# A backup before the new server opens the database and runs its migrations (#470), so a bad one
# rolls back to this deploy's data rather than the night's. The old server still runs, so writes
# in the seconds until it stops are not in it. A failed backup stops the deploy before the server
# is replaced: no migration runs without one. The last five are kept. A new host has no volume yet.
mnt=$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data 2>/dev/null) || mnt=
db=$mnt/starbridge.db
if [ -n "$mnt" ] && [ -f "$db" ]; then
  out=/var/backups/starbridge/deploy-$(date -u +%Y%m%dT%H%M%S).db
  mkdir -p /var/backups/starbridge
  (umask 077 && sqlite3 "$db" ".backup '$out.tmp'")
  # As in backup.sh: sqlite3 runs as root, so hand back any WAL or shared-memory file it made.
  chown --reference="$db" "$db"-wal "$db"-shm 2>/dev/null || true
  sqlite3 "$out.tmp" 'PRAGMA integrity_check' | grep -qx ok
  mv "$out.tmp" "$out"
  ls -t /var/backups/starbridge/deploy-*.db | tail -n +6 | xargs -r rm -f
fi

# The server stays one instance: it holds the long-polls and SQLite. On SIGTERM it ends its
# long-polls and exits, and Caddy holds requests until the new one answers. --remove-orphans
# drops the single `web` of releases before two copies.
$compose up -d --remove-orphans server umami umami-db caddy

healthy http://127.0.0.1:8080/healthz server
# Umami migrates its database on its first start.
healthy http://127.0.0.1:3001/api/heartbeat umami 120

# /healthz/backup fails until a first backup ran; run one now rather than wait for the night.
[ -e "$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)/last-backup" ] ||
  systemctl start starbridge-backup.service

# Cleanup last, and never a reason to fail a deploy that is already serving. Each build leaves
# about 0.9 GB of cache; unpruned, a day of deploys left 27 GB of it on the 38 GB disk (#301).
# The newest 3 GB keep the next build fast.
docker image prune -f >/dev/null || true
docker image ls starbridge-caddy --format '{{.Repository}}:{{.Tag}}' | grep -vx -e starbridge-caddy:latest -e "$caddy" |
  xargs -r docker image rm >/dev/null || true
docker builder prune -f --keep-storage 3GB >/dev/null || true
