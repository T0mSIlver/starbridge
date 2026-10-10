#!/bin/sh
# Gives the demo server for Play reviewers (#423) its owner token on starbridge-1 and starts it
# from prod's checkout, /opt/starbridge; safe to run again, and how to change the token. From then
# on every prod deploy rebuilds it (deploy/host/apply.sh, #1016). It touches nothing of prod's.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
token=$HOME/.config/starbridge/secrets/demo-owner-token
[ -s "$token" ] || { echo "no $token" >&2; exit 1; }

# The owner token goes through stdin, never the command line.
printf "OWNER_TOKEN='%s'\n" "$(tr -d '\n' < "$token")" | ssh -i "$key" "$host" "sudo sh -euc '
  install -d -m 700 /etc/starbridge-demo
  umask 077
  cat > /etc/starbridge-demo/demo.env
'"
ssh -i "$key" "$host" "sudo sh -euc '
  # Shares the lock with the prod deploys, so the two image builds never compete for the disk.
  exec 9>/run/starbridge-deploy.lock
  flock 9
  docker compose -p starbridge-demo -f /opt/starbridge/deploy/demo/compose.yaml up -d --build --force-recreate
  # Where deploy.sh unpacked it before #1016.
  rm -rf /opt/starbridge-demo
'"
curl -fsS --retry 20 --retry-delay 3 --retry-all-errors https://demo.starbridge.run/v1/demo >/dev/null
echo "demo started"
