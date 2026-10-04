#!/bin/sh
# One-time setup for deploys from GitHub Actions; safe to run again. Copies the read-only GitHub
# deploy key and starbridge-deploy to starbridge-1, and authorizes the Actions key for that one
# command. Both keys live in ~/.config/starbridge/secrets.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
src=$HOME/.config/starbridge/secrets
cd "$(git rev-parse --show-toplevel)"

line="command=\"sudo -n /usr/local/sbin/starbridge-deploy \\\"\$SSH_ORIGINAL_COMMAND\\\"\",restrict $(cat "$src/actions-deploy-key.pub")"
scp -q -i "$key" "$src/github-deploy-key" deploy/host/deploy-rev.sh "$host:"
ssh -i "$key" "$host" "sudo sh -euc '
  install -m 600 -o root -g root github-deploy-key /etc/starbridge/github-deploy-key
  install -m 755 -o root -g root deploy-rev.sh /usr/local/sbin/starbridge-deploy
  install -d -m 700 /var/lib/starbridge
  rm github-deploy-key deploy-rev.sh
'
grep -qF '$(cut -d' ' -f2 "$src/actions-deploy-key.pub")' .ssh/authorized_keys || echo '$line' >> .ssh/authorized_keys"
