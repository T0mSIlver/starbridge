#!/bin/sh
# Gives the demo server for Play reviewers (#423) its owner token on sb-staging and starts it from
# staging's checkout, /opt/starbridge-staging; safe to run again, and how to change the token. From
# then on every staging deploy whose round trip passed rebuilds it (staging/deploy-rev.sh, #1557).
# It touches nothing of staging's.
set -eu
host=${STAGING_HOST:-sb-staging}
token=$HOME/.config/starbridge/secrets/demo-owner-token
[ -s "$token" ] || { echo "no $token" >&2; exit 1; }

# The owner token goes through stdin, never the command line.
printf "OWNER_TOKEN='%s'\n" "$(tr -d '\n' < "$token")" | ssh "$host" "sudo sh -euc '
  install -d -m 700 /etc/starbridge-demo
  umask 077
  cat > /etc/starbridge-demo/demo.env
'"
# Under staging's deploy lock, so a deploy never builds beside it.
ssh "$host" "sudo sh -euc '
  exec 9>/run/starbridge-staging-deploy.lock
  flock 9
  /opt/starbridge-staging/deploy/host/demo.sh
'"
echo "demo started on $host"
