#!/bin/sh
# Copies the secrets from this machine to /etc/starbridge/secrets (root, 0700) on starbridge-1:
# the ones named as arguments, or all of them. Only these names, so a plain password never goes.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
src=$HOME/.config/starbridge/secrets
all="github-oauth-client-secret fcm-service-account.json vapid-public-key vapid-private-key stats-password-hash apns-key.p8 apns-key-id apple-signin-key.p8 apple-signin-key-id backup-age.pub offsite-ssh-key offsite-known-hosts offsite-target"
# The Apple keys are optional until the iPhone app ships, and the offsite backup's four (#1482) on
# a self-hosted box: with no names given, a missing one is skipped.
optional="apns-key.p8 apns-key-id apple-signin-key.p8 apple-signin-key-id backup-age.pub offsite-ssh-key offsite-known-hosts offsite-target"
if [ $# -eq 0 ]; then
  files=
  for f in $all; do
    case " $optional " in *" $f "*) [ -f "$src/$f" ] || continue ;; esac
    files="$files $f"
  done
else
  files=$*
fi
for f in $files; do
  case " $all " in *" $f "*) ;; *) echo "not a secret to push: $f" >&2; exit 1 ;; esac
done
# One SSH connection carries the secrets as a tar stream; root unpacks it into a folder only root
# can read, beside the secrets, and removes it on any exit (#1734). A dropped connection leaves
# nothing behind, where a temp folder in /tmp, owned by the login user, once stayed.
remote='set -eu; umask 077; install -d -m 700 /etc/starbridge/secrets; d=$(mktemp -d /etc/starbridge/secrets/.push.XXXXXX)
trap "rm -rf \"\$d\"" EXIT; trap "exit 1" HUP INT TERM
tar -xf - -C "$d" --no-same-owner
for f in "$d"/*; do install -m 600 -o root -g root "$f" /etc/starbridge/secrets/; done'
tar -C "$src" -cf - $files | ssh -i "$key" "$host" "sudo sh -c '$remote'"
