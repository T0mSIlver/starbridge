#!/bin/sh
# From the dev box, once and again after a change: installs staging's deploy command on
# homelab-arm and lets deploy.yml's staging key run it and nothing else. The VM itself (Docker,
# firewall, users) is the homelab's; this only adds to it.
set -eu
host=${STAGING_HOST:-sb-staging}
src=$HOME/.config/starbridge/secrets/staging
cd "$(git rev-parse --show-toplevel)"
line="restrict,command=\"sudo -n /usr/local/sbin/starbridge-staging-deploy \\\"\$SSH_ORIGINAL_COMMAND\\\"\" $(cat "$src/actions-deploy-key.pub")"
scp -q deploy/staging/deploy-rev.sh "$host:starbridge-staging-deploy"
ssh "$host" "sudo sh -euc '
  install -m 755 -o root -g root starbridge-staging-deploy /usr/local/sbin/starbridge-staging-deploy
  rm starbridge-staging-deploy
  install -d -m 755 /etc/starbridge-staging
  install -d -m 700 /etc/starbridge-staging/secrets /var/lib/starbridge-staging
'
grep -qF '$(cut -d' ' -f2 "$src/actions-deploy-key.pub")' .ssh/authorized_keys || echo '$line' >> .ssh/authorized_keys"
