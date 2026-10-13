#!/bin/sh
# Installed on sb-staging as /usr/local/sbin/starbridge-staging-deploy (setup.sh) and run as root
# by the forced command of deploy.yml's staging key, with one argument, a commit id. Deploys that
# commit if it is on main, which it fetches itself over HTTPS, the repository being public. As on
# prod, a commit older than the deployed one is skipped unless it is main's head: CI on an older
# commit can finish after a newer one deployed, and its server would refuse a database the newer
# one migrated.
set -eu
rev=${1:-}
case $rev in
  *[!0-9a-f]* | "") echo "usage: starbridge-staging-deploy <40-hex commit id>" >&2; exit 2 ;;
esac
[ ${#rev} -eq 40 ] || { echo "usage: starbridge-staging-deploy <40-hex commit id>" >&2; exit 2; }

exec 9>/run/starbridge-staging-deploy.lock
flock 9

repo=/var/lib/starbridge-staging/repo.git
mkdir -p /var/lib/starbridge-staging
[ -d $repo ] || git init -q --bare $repo
git -C $repo fetch -q https://github.com/T0mSIlver/starbridge.git +main:main
git -C $repo merge-base --is-ancestor "$rev" main || { echo "$rev is not on main" >&2; exit 1; }
current=$(cat /opt/starbridge-staging/REVISION 2>/dev/null || true)
if [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
  ! git -C $repo merge-base --is-ancestor "$current" "$rev" 2>/dev/null; then
  echo "$rev is older than the deployed ${current:-release} and is not main's head; not deployed"
  exit 0
fi
# seed.sh's seeding server holds the database meanwhile (seed-host.sh).
if [ -n "$(docker ps -q -f name='^sb-seed-server$')" ]; then
  echo "staging is being seeded; not deployed" >&2
  exit 1
fi

dir=/opt/starbridge-staging
rm -rf $dir.new $dir.old
mkdir $dir.new
git -C $repo archive --format=tar "$rev" | tar -x -C $dir.new
if [ -d $dir ]; then mv $dir $dir.old; fi
mv $dir.new $dir
REVISION=$rev $dir/deploy/staging/apply.sh
echo "$rev" > $dir/REVISION
# Then one round trip on staging's test account (#1528): a card, its Web Push, an answer read
# back, from the outside check's staging instance on this VM (starbridge-planning,
# infra/sb-staging). Its failure fails the deploy, and prod waits for this one (deploy.yml).
# Until that instance is set up, it says so and passes.
check=/var/lib/sb-check-staging
if [ -x /usr/local/sbin/sb-check-now ] && [ "$(cat $check/setup-state 2>/dev/null)" = done ]; then
  /usr/local/sbin/sb-check-now $check
else
  echo "no round trip: the staging check is not set up"
fi
# The last line deploy.yml reads: only a commit that went through all of the above lets prod
# deploy it. A skipped older commit ends without it.
echo "passed $rev"
