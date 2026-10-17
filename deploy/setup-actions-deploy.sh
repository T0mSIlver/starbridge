#!/bin/sh
# One-time setup for deploys from GitHub Actions; safe to run again. Installs the box's deploy
# command (host/deploy-rev.sh with the box's settings ahead of it) and authorizes the Actions
# deploy key for that one command. Prod also gets the read-only GitHub deploy key it fetches main
# with. The keys live in ~/.config/starbridge/secrets, staging's under staging/. Prod's /etc folder
# comes from host/setup.sh; sb-staging's from here.
#   deploy/setup-actions-deploy.sh [prod]
#   deploy/setup-actions-deploy.sh staging
set -eu
cd "$(git rev-parse --show-toplevel)/deploy"
env=host/prod.env
case ${1:-prod} in
prod) ;;
staging) env=staging/staging.env ;;
*) echo "usage: deploy/setup-actions-deploy.sh [prod|staging]" >&2; exit 2 ;;
esac
. "./$env"
src=$HOME/$SECRETS_SRC
set -- ${SSH_KEY:+-i "$HOME/$SSH_KEY"}

line="restrict,command=\"sudo -n /usr/local/sbin/$COMMAND \\\"\$SSH_ORIGINAL_COMMAND\\\"\" $(cat "$src/actions-deploy-key.pub")"
command=$(mktemp)
trap 'rm -f "$command"' EXIT
{
  echo '#!/bin/sh'
  cat "$env"
  cat host/deploy-rev.sh
} > "$command"
scp -q "$@" "$command" "$SSH_HOST:$COMMAND"
key=
if [ -n "$GITHUB_KEY" ]; then
  scp -q "$@" "$src/github-deploy-key" "$SSH_HOST:github-deploy-key"
  key="install -m 600 -o root -g root github-deploy-key $GITHUB_KEY && rm github-deploy-key"
fi
ssh "$@" "$SSH_HOST" "sudo sh -euc '
  install -m 755 -o root -g root $COMMAND /usr/local/sbin/$COMMAND
  rm $COMMAND
  [ -d /etc/$PROJECT ] || install -d -m 755 /etc/$PROJECT
  install -d -m 700 /etc/$PROJECT/secrets /var/lib/$PROJECT
  $key
'
grep -qF '$(cut -d' ' -f2 "$src/actions-deploy-key.pub")' .ssh/authorized_keys || echo '$line' >> .ssh/authorized_keys"
