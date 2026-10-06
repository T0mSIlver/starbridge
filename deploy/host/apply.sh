#!/bin/sh
# Run as root on starbridge-1 after deploy.sh has unpacked a release into /opt/starbridge.
set -eu
cd /opt/starbridge/deploy
compose="docker compose -p starbridge -f compose.yaml"

install -m 644 host/starbridge-backup.service host/starbridge-backup.timer \
  host/starbridge-umami-trim.service host/starbridge-umami-trim.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now starbridge-backup.timer starbridge-umami-trim.timer
install -m 755 host/deploy-rev.sh /usr/local/sbin/starbridge-deploy

host/server-env.sh
host/umami-env.sh
$compose build --pull server web-a
# Not pulled: Caddy's image changes only when caddy.Dockerfile does.
$compose build caddy

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

# The server stays one instance: it holds the long-polls and SQLite. On SIGTERM it ends its
# long-polls and exits, and Caddy holds requests until the new one answers. --remove-orphans
# drops the single `web` of releases before two copies.
$compose up -d --remove-orphans server umami umami-db caddy
docker image prune -f >/dev/null
# Each build leaves about 0.9 GB of cache; unpruned, a day of deploys left 27 GB of it on the
# 38 GB disk (#301). The newest 3 GB keep the next build fast.
docker builder prune -f --keep-storage 3GB >/dev/null

healthy http://127.0.0.1:8080/healthz server
# Umami migrates its database on its first start.
healthy http://127.0.0.1:3001/api/heartbeat umami 120

# /healthz/backup fails until a first backup ran; run one now rather than wait for the night.
[ -e "$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)/last-backup" ] ||
  systemctl start starbridge-backup.service
