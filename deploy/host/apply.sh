#!/bin/sh
# Run as root on starbridge-1 after deploy.sh has unpacked a release into /opt/starbridge.
set -eu
cd /opt/starbridge/deploy
compose="docker compose -p starbridge -f compose.yaml"

install -m 644 host/starbridge-backup.service host/starbridge-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now starbridge-backup.timer

host/server-env.sh
$compose build --pull server
$compose up -d --remove-orphans
# The bind-mounted Caddyfile is a new file on every release; recreate Caddy only when it changed.
if ! cmp -s /opt/starbridge.old/deploy/Caddyfile Caddyfile; then
  $compose up -d --force-recreate caddy
fi
docker image prune -f >/dev/null

for _ in $(seq 30); do
  curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "server not healthy after 30 s" >&2
$compose logs --tail 50 server >&2
exit 1
