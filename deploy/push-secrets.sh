#!/bin/sh
# Copies a box's secrets from this machine to /etc/<project>/secrets (root, 0700) on the box: the
# ones named as arguments, or all of them. Only the box's names (host/prod.env, staging/staging.env),
# so a plain password never goes, and none of prod's go to staging.
#   deploy/push-secrets.sh [prod] [<name>...]    starbridge.run, from ~/.config/starbridge/secrets
#   deploy/push-secrets.sh staging [<name>...]   sb-staging, from ~/.config/starbridge/secrets/staging
set -eu
cd "$(dirname "$0")"
env=host/prod.env
case ${1:-} in
prod) shift ;;
staging) env=staging/staging.env && shift ;;
esac
. "./$env"
src=$HOME/$SECRETS_SRC
# With no names given, a missing optional one is skipped.
if [ $# -eq 0 ]; then
  files=
  for f in $SECRETS; do
    case " $SECRETS_OPTIONAL " in *" $f "*) [ -f "$src/$f" ] || continue ;; esac
    files="$files $f"
  done
else
  files=$*
fi
for f in $files; do
  case " $SECRETS " in *" $f "*) ;; *) echo "not a secret to push to $LABEL: $f" >&2; exit 1 ;; esac
  # tar would skip a missing one and the pipe would still succeed.
  [ -s "$src/$f" ] || { echo "missing: $src/$f" >&2; exit 1; }
done
# One SSH connection carries the secrets as a tar stream; root unpacks it into a folder only root
# can read, beside the secrets, and removes it on any exit (#1734). A dropped connection leaves
# nothing behind, where a temp folder in /tmp, owned by the login user, once stayed.
remote="set -eu; umask 077; install -d -m 700 /etc/$PROJECT/secrets; d=\$(mktemp -d /etc/$PROJECT/secrets/.push.XXXXXX)
trap \"rm -rf \\\"\\\$d\\\"\" EXIT; trap \"exit 1\" HUP INT TERM
tar -xf - -C \"\$d\" --no-same-owner
for f in \"\$d\"/*; do install -m 600 -o root -g root \"\$f\" /etc/$PROJECT/secrets/; done"
tar -C "$src" -cf - $files | ssh ${SSH_KEY:+-i "$HOME/$SSH_KEY"} "$SSH_HOST" "sudo sh -c '$remote'"
