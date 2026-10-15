#!/bin/sh
# Installed as /usr/local/sbin/starbridge-deploy and run as root by the forced commands of two
# Actions keys, with a commit id (deploy/setup-actions-deploy.sh, setup-actions-rollback.sh).
#   starbridge-deploy <commit>              the deploy key: main's head, or a commit on main that
#                                           contains the one deployed now
#   starbridge-deploy --rollback <commit>   the rollback key: a commit this box ran before (#1828),
#                                           listed in $deployed below
# Either way only a commit on main, which it fetches itself with a read-only deploy key, and only
# once staging passed it (below). So a leaked deploy key can neither deploy a branch, roll back to
# an older, weaker release, nor skip staging, and a leaked rollback key can only go back to a
# release that ran here. Deploys around these checks are the owner's, with deploy/deploy.sh.
set -eu
usage() { echo "usage: starbridge-deploy [--rollback] <40-hex commit id>" >&2; exit 2; }
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

exec 9>/run/starbridge-deploy.lock
flock 9

repo=/var/lib/starbridge/repo.git
# GitHub's published host key (docs.github.com, "GitHub's SSH key fingerprints"), not whichever
# key the first fetch on a new box happens to see: what it fetches runs as root.
known=/var/lib/starbridge/github_known_hosts
mkdir -p /var/lib/starbridge
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > $known
export GIT_SSH_COMMAND="ssh -i /etc/starbridge/github-deploy-key -o IdentitiesOnly=yes -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes"
[ -d $repo ] || git init -q --bare $repo
git -C $repo fetch -q git@github.com:T0mSIlver/starbridge.git +main:main
git -C $repo merge-base --is-ancestor "$rev" main || { echo "$rev is not on main" >&2; exit 1; }
current=$(cat /opt/starbridge/REVISION 2>/dev/null || true)
# Every commit this box ran, one per line: what --rollback may go back to.
deployed=/var/lib/starbridge/deployed
record() {
  case $1 in *[!0-9a-f]* | "") return 0 ;; esac
  [ ${#1} -eq 40 ] || return 0
  grep -qxF "$1" $deployed 2>/dev/null || echo "$1" >> $deployed
}
if [ -n "$rollback" ]; then
  grep -qxF "$rev" $deployed 2>/dev/null || { echo "starbridge.run never ran $rev; not rolled back" >&2; exit 1; }
  [ "$rev" != "$current" ] || { echo "starbridge.run already runs $rev"; exit 0; }
# CI on an older commit of main can finish after a newer one deployed: that run deploys nothing.
elif [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
  ! git -C $repo merge-base --is-ancestor "$current" "$rev" 2>/dev/null; then
  echo "$rev is older than the deployed ${current:-release} and is not main's head; not deployed"
  exit 0
fi

# Staging passed this commit (#1528, #1714). deploy.yml checks it before it calls this command;
# the box checks again, so the Actions key alone cannot skip staging. Any workflow can post a
# commit status, so the status only points at its run: that run must be main's deploy.yml, and
# its staging job must have run the step named "Staging passed <this commit>", which only a pass
# runs. GitHub's public API, without a token: the repository is public, so the box holds no GitHub
# credential for it. No answer means no deploy.
api=https://api.github.com/repos/T0mSIlver/starbridge
# get PATH: the answer, or nothing when curl fails. Through a file: a retried transfer's partial
# bytes would otherwise reach the parser ahead of the full answer.
get() {
  out=$(mktemp)
  curl -fsS --retry 3 --retry-delay 5 --retry-all-errors --max-time 30 \
    -H 'Accept: application/vnd.github+json' -o "$out" "$api/$1" && cat "$out" || true
  rm -f "$out"
}
run=$(get "commits/$rev/statuses?per_page=100" |
  jq -r '[.[] | select(.context == "staging")][0] | select(.state == "success") | .target_url' |
  sed -n 's|^https://github\.com/T0mSIlver/starbridge/actions/runs/\([0-9][0-9]*\)$|\1|p') || run=
[ -n "$run" ] || { echo "staging has not passed $rev; not deployed" >&2; exit 1; }
get "actions/runs/$run" | jq -e '.path == ".github/workflows/deploy.yml" and .event == "workflow_run"
  and .head_branch == "main" and .head_repository.full_name == "T0mSIlver/starbridge"' >/dev/null ||
  { echo "the staging status of $rev names run $run, not main's deploy.yml; not deployed" >&2; exit 1; }
# The step ran before the status was set, but the API can show it a few seconds late. The same
# job names the image digests staging ran (#1715), which this deploy runs, so a tag pushed again
# after staging passed changes nothing here.
digests=
for _ in 1 2 3 4 5 6; do
  digests=$(get "actions/runs/$run/jobs?filter=latest&per_page=100" | jq -r --arg step "Staging passed $rev" '
    [.jobs[] | select(.name == "staging") | .steps[] | select(.conclusion == "success") | .name] as $done
    | if any($done[]; . == $step) then
        [$done[] | capture("^Staging ran (?<i>server|web)@(?<d>sha256:[0-9a-f]{64})$")]
        | select(([.[].i] | sort) == ["server", "web"]) | map("\(.i) \(.d)") | .[]
      else empty end') || digests=
  [ -z "$digests" ] || break
  sleep 5
done
server=$(printf '%s\n' "$digests" | sed -n 's/^server //p')
web=$(printf '%s\n' "$digests" | sed -n 's/^web //p')
[ -n "$server" ] && [ -n "$web" ] ||
  { echo "run $run did not pass $rev on staging, or names no image digests; not deployed" >&2; exit 1; }
echo "staging passed $rev (run $run) with server@$server web@$web"

# The running commit goes on the record first, so the first deploy by this script makes the
# release before it one to go back to. One the owner deployed around these checks is recorded too;
# --rollback still checks it as above.
record "$current"
# apply.sh installs its own tree's deploy-rev.sh as this command, and an older tree's may not
# know --rollback: after a rollback, failed or not, this command comes back, so the next rollback
# still works and the command never goes back to older checks.
if [ -n "$rollback" ]; then
  self=$(mktemp)
  cp /usr/local/sbin/starbridge-deploy "$self"
  trap 'install -m 755 -o root -g root "$self" /usr/local/sbin/starbridge-deploy; rm -f "$self"' EXIT
fi

rm -rf /opt/starbridge.new /opt/starbridge.old
mkdir /opt/starbridge.new
git -C $repo archive --format=tar "$rev" | tar -x -C /opt/starbridge.new
if [ -d /opt/starbridge ]; then mv /opt/starbridge /opt/starbridge.old; fi
mv /opt/starbridge.new /opt/starbridge
REVISION=$rev SERVER_DIGEST=$server WEB_DIGEST=$web /opt/starbridge/deploy/host/apply.sh
# Only once it is up and healthy: a failed deploy leaves no REVISION, so only main's head or a
# rollback deploys next, and neither check above trusts a release that never ran.
echo "$rev" > /opt/starbridge/REVISION
record "$rev"
