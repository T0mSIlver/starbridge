#!/bin/sh
# Authorizes rollback.yml's key on a box for one command, `starbridge-deploy --rollback <commit>`
# on prod or `starbridge-staging-deploy --rollback <commit>` on sb-staging (#1828); safe to run
# again. Takes the public half only: the private half goes straight into the environment's
# ROLLBACK_SSH_KEY secret and is never kept here. The box must run a deploy-rev.sh with --rollback,
# which every deploy installs.
#   deploy/setup-actions-rollback.sh prod    rollback-key.pub
#   deploy/setup-actions-rollback.sh staging rollback-key.pub
set -eu
[ $# -eq 2 ] || { echo "usage: deploy/setup-actions-rollback.sh prod|staging <public key file>" >&2; exit 2; }
target=$1
pub=$(cat "$2")
case $pub in ssh-ed25519\ *) ;; *) echo "$2 is not an ed25519 public key" >&2; exit 1 ;; esac
case $target in
prod)
  set -- -i "$HOME/.ssh/starbridge_ed25519" "${STARBRIDGE_HOST:-deploy@starbridge.run}"
  command=/usr/local/sbin/starbridge-deploy
  ;;
staging)
  set -- "${STAGING_HOST:-sb-staging}"
  command=/usr/local/sbin/starbridge-staging-deploy
  ;;
*) echo "usage: deploy/setup-actions-rollback.sh prod|staging <public key file>" >&2; exit 2 ;;
esac
# The key part alone, without its comment, as the line below writes it.
key=$(echo "$pub" | cut -d' ' -f1-2)
line="restrict,command=\"sudo -n $command --rollback \\\"\$SSH_ORIGINAL_COMMAND\\\"\" $key starbridge-actions-rollback"
ssh "$@" "grep -qF '$(echo "$key" | cut -d' ' -f2)' .ssh/authorized_keys || echo '$line' >> .ssh/authorized_keys"
echo "authorized on $target: $line"
