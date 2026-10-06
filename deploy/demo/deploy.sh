#!/bin/sh
# Deploys the demo server for Play reviewers (#423) to starbridge-1 from a pushed git ref
# (default: origin/main): unpacks it in /opt/starbridge-demo and rebuilds the starbridge-demo
# Compose project. It touches nothing of prod's: not /opt/starbridge, its volumes nor its
# services. Prod's Caddy serves demo.starbridge.run once a deploy of main has loaded the Caddyfile.
set -eu
ref=${1:-origin/main}
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
token=$HOME/.config/starbridge/secrets/demo-owner-token
cd "$(git rev-parse --show-toplevel)"

git fetch -q origin
rev=$(git rev-parse --verify "$ref^{commit}")
if [ -z "$(git branch -r --contains "$rev")" ]; then
  echo "$ref ($rev) is not on origin; push it first" >&2
  exit 1
fi
[ -s "$token" ] || { echo "no $token" >&2; exit 1; }

# The owner token goes through stdin, never the command line.
printf "OWNER_TOKEN='%s'\n" "$(tr -d '\n' < "$token")" | ssh -i "$key" "$host" "sudo sh -euc '
  install -d -m 700 /etc/starbridge-demo
  umask 077
  cat > /etc/starbridge-demo/demo.env
'"
git archive --format=tar "$rev" | ssh -i "$key" "$host" "sudo sh -euc '
  # Shares prod deploys' lock, so the two image builds never compete for the disk.
  exec 9>/run/starbridge-deploy.lock
  flock 9
  rm -rf /opt/starbridge-demo.new
  mkdir /opt/starbridge-demo.new
  tar -x -C /opt/starbridge-demo.new
  rm -rf /opt/starbridge-demo
  mv /opt/starbridge-demo.new /opt/starbridge-demo
  docker compose -p starbridge-demo -f /opt/starbridge-demo/deploy/demo/compose.yaml up -d --build --force-recreate
  docker image prune -f >/dev/null
'"
curl -fsS --retry 20 --retry-delay 3 --retry-all-errors https://demo.starbridge.run/v1/demo >/dev/null
echo "demo deployed $rev"
