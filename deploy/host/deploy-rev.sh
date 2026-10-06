#!/bin/sh
# Installed as /usr/local/sbin/starbridge-deploy and run as root by the Actions deploy key's
# forced command with one argument, a commit id. Deploys that commit only if it is GitHub's main,
# which it fetches itself with a read-only deploy key, or a commit on main that contains the one
# deployed now, so a leaked Actions key can neither deploy a branch nor roll back to an older,
# weaker release. Rollbacks are the owner's, with deploy/deploy.sh.
set -eu
rev=${1:-}
case $rev in
  *[!0-9a-f]* | "") echo "usage: starbridge-deploy <40-hex commit id>" >&2; exit 2 ;;
esac
[ ${#rev} -eq 40 ] || { echo "usage: starbridge-deploy <40-hex commit id>" >&2; exit 2; }

exec 9>/run/starbridge-deploy.lock
flock 9

repo=/var/lib/starbridge/repo.git
export GIT_SSH_COMMAND="ssh -i /etc/starbridge/github-deploy-key -o IdentitiesOnly=yes -o UserKnownHostsFile=/var/lib/starbridge/known_hosts -o StrictHostKeyChecking=accept-new"
[ -d $repo ] || git init -q --bare $repo
git -C $repo fetch -q git@github.com:T0mSIlver/starbridge.git +main:main
git -C $repo merge-base --is-ancestor "$rev" main || { echo "$rev is not on main" >&2; exit 1; }
# CI on an older commit of main can finish after a newer one deployed: that run deploys nothing.
current=$(cat /opt/starbridge/REVISION 2>/dev/null || true)
if [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
  ! git -C $repo merge-base --is-ancestor "$current" "$rev" 2>/dev/null; then
  echo "$rev is older than the deployed ${current:-release} and is not main's head; not deployed"
  exit 0
fi

rm -rf /opt/starbridge.new /opt/starbridge.old
mkdir /opt/starbridge.new
git -C $repo archive --format=tar "$rev" | tar -x -C /opt/starbridge.new
echo "$rev" > /opt/starbridge.new/REVISION
if [ -d /opt/starbridge ]; then mv /opt/starbridge /opt/starbridge.old; fi
mv /opt/starbridge.new /opt/starbridge
/opt/starbridge/deploy/host/apply.sh
