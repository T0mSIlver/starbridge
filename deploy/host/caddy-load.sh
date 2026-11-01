#!/bin/sh
# caddy-load.sh CADDYFILE: loads it into the running Caddy through its admin API, whose socket
# only root can open (the Caddyfile's `admin`, #1717). Retries for up to 30 s while nothing
# accepts on the socket: a Caddy just started may not have opened it yet, and the file a
# recreated Caddy's predecessor left behind exists before anything listens on it (#2233). A load
# Caddy refuses keeps the running config and fails at once.
set -eu
sock=${CADDY_ADMIN_SOCKET:-/run/starbridge-caddy/admin.sock}
tries=30
while :; do
  code=0
  curl -fsS --unix-socket "$sock" -X POST -H 'Content-Type: text/caddyfile' \
    --data-binary "@$1" http://localhost/load || code=$?
  # 7 is curl's "couldn't connect": a missing socket, or one nothing listens on.
  [ "$code" -eq 7 ] && [ "$tries" -gt 1 ] || exit "$code"
  tries=$((tries - 1))
  sleep 1
done
