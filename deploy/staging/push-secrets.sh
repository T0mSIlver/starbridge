#!/bin/sh
# Copies staging's secrets from ~/.config/starbridge/secrets/staging on this machine to
# /etc/starbridge-staging/secrets (root, 0700) on sb-staging: the ones named, or all of them.
# None of prod's: staging has its own OAuth app and VAPID pair.
set -eu
host=${STAGING_HOST:-sb-staging}
src=$HOME/.config/starbridge/secrets/staging
all="github-oauth-client-id github-oauth-client-secret vapid-public-key vapid-private-key signup-github-ids owner-token"
files=${*:-$all}
for f in $files; do
  case " $all " in *" $f "*) ;; *) echo "not a staging secret: $f" >&2; exit 1 ;; esac
  [ -s "$src/$f" ] || { echo "missing: $src/$f" >&2; exit 1; }
done
# One SSH connection carries the secrets as a tar stream; root unpacks it into a folder only root
# can read, beside the secrets, and removes it on any exit (#1734). A dropped connection leaves
# nothing behind, where a temp folder in /tmp, owned by the login user, once stayed.
remote='set -eu; umask 077; install -d -m 700 /etc/starbridge-staging/secrets; d=$(mktemp -d /etc/starbridge-staging/secrets/.push.XXXXXX)
trap "rm -rf \"\$d\"" EXIT; trap "exit 1" HUP INT TERM
tar -xf - -C "$d" --no-same-owner
for f in "$d"/*; do install -m 600 -o root -g root "$f" /etc/starbridge-staging/secrets/; done'
tar -C "$src" -cf - $files | ssh "$host" "sudo sh -c '$remote'"
