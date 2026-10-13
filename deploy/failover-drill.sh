#!/bin/sh
# The failover drill (deploy/README.md, "Failover"), from the operator's machine: last night's
# offsite copy boots on sb-staging under a side name, so users never move, and each step is
# timed. Staging must be stopped first: the drill's Caddy takes ports 80 and 443.
#   deploy/failover-drill.sh up      restore the copy, boot prod's server on it, Caddy in front
#   deploy/failover-drill.sh wait    once the owner added the A record: time it to the first HTTPS answer
#   deploy/failover-drill.sh down    remove the drill and the copy; then delete the A record
set -eu
host=${STAGING_HOST:-sb-staging}
name=failover.starbridge.run
caddy=caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb
cd "$(git rev-parse --show-toplevel)"
now() { date +%s; }

case ${1:-} in
up)
  # The commit prod runs: the server that would take over.
  rev=$(curl -fsS -D - -o /dev/null https://starbridge.run/healthz | tr -d '\r' |
    awk -F': ' 'tolower($1) == "x-starbridge-revision" { print $2 }')
  case $rev in *[!0-9a-f]* | "") echo "starbridge.run names no revision" >&2; exit 1 ;; esac
  t0=$(now)
  deploy/failover-restore.sh "$host"
  t1=$(now)
  ssh "$host" "sudo sh -euc '
    docker rm -f sb-drill-server sb-drill-caddy >/dev/null 2>&1 || true
    # The copy must reach no phone or browser: its server would deliver due snoozes and held
    # notifications, and UnifiedPush needs no credential. Without push subscriptions it has nowhere
    # to send; without sign-in or relay settings it shows the copy boots and answers, nothing more.
    sqlite3 \$(docker volume inspect -f {{.Mountpoint}} starbridge_data)/starbridge.db \
      \"DELETE FROM push_subscriptions\"
    docker run -d --name sb-drill-server -p 127.0.0.1:18090:8080 -v starbridge_data:/data \
      -e PUBLIC_URL=https://$name ghcr.io/t0msilver/starbridge-server:$rev >/dev/null
    for _ in \$(seq 120); do curl -fsS http://127.0.0.1:18090/healthz >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS http://127.0.0.1:18090/healthz >/dev/null
    printf \"%s {\n\treverse_proxy 127.0.0.1:18090\n}\n\" $name > /tmp/drill.Caddyfile
    docker run -d --name sb-drill-caddy --network host -v /tmp/drill.Caddyfile:/etc/caddy/Caddyfile:ro \
      -v sb-drill-caddy:/data $caddy >/dev/null
  '"
  t2=$(now)
  echo "restored in $((t1 - t0)) s; server $rev answering $((t2 - t1)) s later"
  echo "now add: A $name -> 79.76.109.122, DNS only; then run: deploy/failover-drill.sh wait"
  ;;
wait)
  t0=$(now)
  until curl -fsS --max-time 10 -o /dev/null "https://$name/healthz" 2>/dev/null; do
    [ $(($(now) - t0)) -lt 1800 ] || { echo "no HTTPS answer from $name in 30 min" >&2; exit 1; }
    sleep 5
  done
  echo "https://$name answered $(($(now) - t0)) s after this started"
  ;;
down)
  ssh "$host" "sudo sh -euc '
    docker rm -f sb-drill-server sb-drill-caddy >/dev/null 2>&1 || true
    docker volume rm sb-drill-caddy >/dev/null 2>&1 || true
    mnt=\$(docker volume inspect -f {{.Mountpoint}} starbridge_data 2>/dev/null) || exit 0
    find \$mnt -type f -exec shred -u {} +
    docker volume rm starbridge_data >/dev/null
    rm -f /tmp/drill.Caddyfile
  '"
  echo "drill removed from $host; delete the A record of $name"
  ;;
*) echo "usage: deploy/failover-drill.sh up|wait|down" >&2; exit 2 ;;
esac
