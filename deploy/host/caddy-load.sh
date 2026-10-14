#!/bin/sh
# caddy-load.sh CADDYFILE: loads it into the running Caddy through its admin API, whose socket
# only root can open (the Caddyfile's `admin`, #1717). Waits up to 30 s for a Caddy just started
# to open the socket. A load Caddy refuses keeps the running config and fails.
set -eu
sock=${CADDY_ADMIN_SOCKET:-/run/starbridge-caddy/admin.sock}
for _ in $(seq 30); do
  [ -S "$sock" ] && break
  sleep 1
done
curl -fsS --unix-socket "$sock" -X POST -H 'Content-Type: text/caddyfile' \
  --data-binary "@$1" http://localhost/load
