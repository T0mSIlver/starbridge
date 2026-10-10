#!/bin/sh
# Deploys a pushed git ref (default: origin/main) to starbridge-1: unpacks it in
# /opt/starbridge, rebuilds the server image there and restarts the stack.
set -eu
ref=${1:-origin/main}
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
cd "$(git rev-parse --show-toplevel)"

git fetch -q origin
rev=$(git rev-parse --verify "$ref^{commit}")
if [ -z "$(git branch -r --contains "$rev")" ]; then
  echo "$ref ($rev) is not on origin; push it first" >&2
  exit 1
fi

git archive --format=tar "$rev" | ssh -i "$key" "$host" "sudo sh -euc '
  # Shares the lock with starbridge-deploy, the deploy from Actions.
  exec 9>/run/starbridge-deploy.lock
  flock 9
  rm -rf /opt/starbridge.new /opt/starbridge.old
  mkdir /opt/starbridge.new
  tar -x -C /opt/starbridge.new
  if [ -d /opt/starbridge ]; then mv /opt/starbridge /opt/starbridge.old; fi
  mv /opt/starbridge.new /opt/starbridge
  REVISION=$rev /opt/starbridge/deploy/host/apply.sh
  # Only once it is up and healthy: starbridge-deploy refuses revisions older than this one.
  echo $rev > /opt/starbridge/REVISION
  /opt/starbridge/deploy/host/demo.sh || { echo \"$rev is live; the demo server did not deploy\" >&2; exit 1; }
'"
# The first deploy waits for Caddy's certificate. The server names the commit it was built from.
# Headers to a file, not a pipe: an unreachable server must fail the script.
headers=$(mktemp)
curl -fsS --retry 20 --retry-delay 3 --retry-all-errors -D "$headers" -o /dev/null https://starbridge.run/healthz
got=$(tr -d '\r' < "$headers" | awk -F': ' 'tolower($1) == "x-starbridge-revision" { print $2 }')
rm -f "$headers"
# Commits before the header existed name none.
if [ -z "$got" ]; then
  echo "starbridge.run names no revision; check it runs $rev" >&2
elif case $got in *[!0-9a-f]*) true ;; *) [ ${#got} -ne 40 ] ;; esac; then
  echo "starbridge.run names no commit id" >&2
  exit 1
elif [ "$got" != "$rev" ]; then
  echo "starbridge.run runs $got, not $rev" >&2
  exit 1
fi
echo "deployed $rev"
