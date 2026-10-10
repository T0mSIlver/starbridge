#!/bin/sh
# Run as root on starbridge-1 after each prod deploy, from the same checkout: the demo server for
# Play reviewers (#423) follows prod (#1016). One left behind once rejected the apps' item kinds,
# and reviewers saw an empty inbox. Compose recreates it only when its image changed, which the
# build cache keeps from happening unless its code did: each start is a fresh account, and a
# reviewer's would go with it. Does nothing until deploy/demo/setup.sh gave it its owner token.
set -eu
[ -f /etc/starbridge-demo/demo.env ] || exit 0
demo="docker compose -p starbridge-demo -f /opt/starbridge/deploy/demo/compose.yaml"
$demo build
$demo up -d
for _ in $(seq 30); do
  curl -fsS http://127.0.0.1:8090/healthz >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "demo.sh: the demo server is not healthy after 30 s" >&2
$demo logs --tail 50 >&2
exit 1
