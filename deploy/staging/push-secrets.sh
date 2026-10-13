#!/bin/sh
# Copies staging's secrets from ~/.config/starbridge/secrets/staging on this machine to
# /etc/starbridge-staging/secrets (root, 0700) on homelab-arm: the ones named, or all of them.
# None of prod's: staging has its own OAuth app and VAPID pair.
set -eu
host=${STAGING_HOST:-sb-staging}
src=$HOME/.config/starbridge/secrets/staging
all="github-oauth-client-id github-oauth-client-secret vapid-public-key vapid-private-key signup-github-ids"
files=${*:-$all}
for f in $files; do
  case " $all " in *" $f "*) ;; *) echo "not a staging secret: $f" >&2; exit 1 ;; esac
  [ -s "$src/$f" ] || { echo "missing: $src/$f" >&2; exit 1; }
done
tmp=$(ssh "$host" 'umask 077; mktemp -d')
trap 'ssh "$host" "rm -rf $tmp"' EXIT
(cd "$src" && scp -q $files "$host:$tmp/")
ssh "$host" "sudo install -d -m 700 /etc/starbridge-staging/secrets && sudo install -m 600 -o root -g root $tmp/* /etc/starbridge-staging/secrets/"
