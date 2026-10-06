#!/bin/sh
# Copies the secrets from this machine to /etc/starbridge/secrets (root, 0700) on starbridge-1:
# the ones named as arguments, or all of them. Only these names, so a plain password never goes.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
src=$HOME/.config/starbridge/secrets
all="github-oauth-client-secret fcm-service-account.json vapid-public-key vapid-private-key stats-password-hash"
files=${*:-$all}
for f in $files; do
  case " $all " in *" $f "*) ;; *) echo "not a secret to push: $f" >&2; exit 1 ;; esac
done
staging=$(ssh -i "$key" "$host" 'umask 077; mktemp -d')
trap 'ssh -i "$key" "$host" "rm -rf $staging"' EXIT
(cd "$src" && scp -q -i "$key" $files "$host:$staging/")
ssh -i "$key" "$host" "sudo install -m 600 -o root -g root $staging/* /etc/starbridge/secrets/"
