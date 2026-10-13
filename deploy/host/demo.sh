#!/bin/sh
# Run as root on the host that serves the demo server for Play reviewers (#423), from the checkout
# it deploys: sb-staging after each staging deploy whose round trip passed (#1557), so the demo
# follows main, which serves every release from the minimum up. One left behind prod once
# rejected the apps' item kinds, and reviewers saw an empty inbox (#1016). Compose recreates it only when its image changed, which the
# build cache keeps from happening unless its code did: each start is a fresh account, and a
# reviewer's would go with it. Does nothing until deploy/demo/setup.sh gave it its owner token.
set -eu
[ -f /etc/starbridge-demo/demo.env ] || exit 0
tree=$(cd "$(dirname "$0")/../.." && pwd)
demo="docker compose -p starbridge-demo -f $tree/deploy/demo/compose.yaml"
$demo build
$demo up -d
for _ in $(seq 30); do
  curl -fsS http://127.0.0.1:8090/healthz >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "demo.sh: the demo server is not healthy after 30 s" >&2
$demo logs --tail 50 >&2
exit 1
