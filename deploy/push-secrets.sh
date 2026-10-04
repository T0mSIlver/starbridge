#!/bin/sh
# Copies the secrets from the dev box to /etc/starbridge/secrets (root, 0700) on starbridge-1.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
src=$HOME/.config/starbridge/secrets
files="github-oauth-client-secret fcm-service-account.json vapid-public-key vapid-private-key"
staging=$(ssh -i "$key" "$host" 'umask 077; mktemp -d')
(cd "$src" && scp -q -i "$key" $files "$host:$staging/")
ssh -i "$key" "$host" "sudo install -m 600 -o root -g root $staging/* /etc/starbridge/secrets/ && rm -rf $staging"
