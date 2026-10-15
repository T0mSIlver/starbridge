#!/bin/sh
# Installed on sb-staging as /usr/local/sbin/starbridge-staging-deploy (setup.sh) and run as root
# by the forced commands of deploy.yml's staging key and rollback.yml's staging rollback key, with
# a commit id:
#   starbridge-staging-deploy <commit>              deploys it if it is on main
#   starbridge-staging-deploy --rollback <commit>   deploys it if staging ran it before (#1828)
# Either way only a commit on main, which it fetches itself over HTTPS, the repository being
# public, and only once CI passed it there (below). As on prod, a commit older than the deployed
# one is skipped unless it is main's head or a rollback: CI on an older commit can finish after a
# newer one deployed, and its server would refuse a database the newer one migrated.
set -eu
usage() { echo "usage: starbridge-staging-deploy [--rollback] <40-hex commit id>" >&2; exit 2; }
# The forced commands pass what the client sent as one argument, so the deploy key's client cannot
# add --rollback.
rollback=
if [ $# -eq 2 ] && [ "$1" = --rollback ]; then
  rollback=1
  shift
fi
[ $# -eq 1 ] || usage
rev=$1
case $rev in *[!0-9a-f]* | "") usage ;; esac
[ ${#rev} -eq 40 ] || usage

exec 9>/run/starbridge-staging-deploy.lock
flock 9

repo=/var/lib/starbridge-staging/repo.git
mkdir -p /var/lib/starbridge-staging
[ -d $repo ] || git init -q --bare $repo
git -C $repo fetch -q https://github.com/T0mSIlver/starbridge.git +main:main
git -C $repo merge-base --is-ancestor "$rev" main || { echo "$rev is not on main" >&2; exit 1; }
current=$(cat /opt/starbridge-staging/REVISION 2>/dev/null || true)
# Every commit staging ran, one per line: what --rollback may go back to.
deployed=/var/lib/starbridge-staging/deployed
record() {
  case $1 in *[!0-9a-f]* | "") return 0 ;; esac
  [ ${#1} -eq 40 ] || return 0
  grep -qxF "$1" $deployed 2>/dev/null || echo "$1" >> $deployed
}
if [ -n "$rollback" ]; then
  grep -qxF "$rev" $deployed 2>/dev/null || { echo "staging never ran $rev; not rolled back" >&2; exit 1; }
  [ "$rev" != "$current" ] || { echo "staging already runs $rev"; exit 0; }
elif [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
  ! git -C $repo merge-base --is-ancestor "$current" "$rev" 2>/dev/null; then
  echo "$rev is older than the deployed ${current:-release} and is not main's head; not deployed"
  exit 0
fi
# CI passed this commit on a push to main (#1714). deploy.yml deploys only such a commit; the box
# checks again, so the staging key alone cannot ship one that failed. Only main's pushes make such
# runs of ci.yml. GitHub's public API, without a token; no answer means no deploy.
# Through a file, and only when curl succeeds: a retried transfer's partial bytes would otherwise
# reach jq ahead of the full answer.
runs=$(mktemp)
curl -fsS --retry 3 --retry-delay 5 --retry-all-errors --max-time 30 -H 'Accept: application/vnd.github+json' -o "$runs" \
  "https://api.github.com/repos/T0mSIlver/starbridge/actions/workflows/ci.yml/runs?head_sha=$rev&event=push&branch=main&status=success&per_page=10" &&
  jq -e --arg rev "$rev" 'any(.workflow_runs[]; .path == ".github/workflows/ci.yml" and .event == "push"
    and .head_branch == "main" and .head_sha == $rev and .conclusion == "success"
    and .head_repository.full_name == "T0mSIlver/starbridge")' "$runs" >/dev/null ||
  { rm -f "$runs"; echo "CI has not passed $rev on main; not deployed" >&2; exit 1; }
rm -f "$runs"
echo "CI passed $rev on main"
# seed.sh's seeding server holds the database meanwhile (seed-host.sh).
if [ -n "$(docker ps -q -f name='^sb-seed-server$')" ]; then
  echo "staging is being seeded; not deployed" >&2
  exit 1
fi

# The running commit first, so the first deploy by this script makes the one before it a rollback
# target.
record "$current"

dir=/opt/starbridge-staging
rm -rf $dir.new $dir.old
mkdir $dir.new
git -C $repo archive --format=tar "$rev" | tar -x -C $dir.new
if [ -d $dir ]; then mv $dir $dir.old; fi
mv $dir.new $dir
REVISION=$rev $dir/deploy/staging/apply.sh
echo "$rev" > $dir/REVISION
record "$rev"
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
# Then the Play reviewers' demo server, from this checkout, only after the round trip passed: a
# project of its own, which restarts only when its code changed (host/demo.sh). Its failure is
# reported but blocks no release, and a cold build (about 5 minutes on this VM) is cut at 8, inside
# the staging job's limit (deploy.yml).
timeout 480 $dir/deploy/host/demo.sh || echo "the demo server did not deploy; see above" >&2
# The last line deploy.yml reads: only a commit that went through all of the above lets prod
# deploy it. A skipped older commit ends without it.
echo "passed $rev"
