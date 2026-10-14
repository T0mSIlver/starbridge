#!/bin/sh
# Installed as /usr/local/sbin/starbridge-deploy and run as root by the Actions deploy key's
# forced command with one argument, a commit id. Deploys that commit only if it is GitHub's main,
# which it fetches itself with a read-only deploy key, or a commit on main that contains the one
# deployed now, and only once staging passed it (below). So a leaked Actions key can neither
# deploy a branch, roll back to an older, weaker release, nor skip staging. Rollbacks and
# deploys around staging are the owner's, with deploy/deploy.sh.
set -eu
rev=${1:-}
case $rev in
  *[!0-9a-f]* | "") echo "usage: starbridge-deploy <40-hex commit id>" >&2; exit 2 ;;
esac
[ ${#rev} -eq 40 ] || { echo "usage: starbridge-deploy <40-hex commit id>" >&2; exit 2; }

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
# CI on an older commit of main can finish after a newer one deployed: that run deploys nothing.
current=$(cat /opt/starbridge/REVISION 2>/dev/null || true)
if [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
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
get() {
  curl -fsS --retry 3 --retry-delay 5 --retry-all-errors --max-time 30 \
    -H 'Accept: application/vnd.github+json' "$api/$1"
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

rm -rf /opt/starbridge.new /opt/starbridge.old
mkdir /opt/starbridge.new
git -C $repo archive --format=tar "$rev" | tar -x -C /opt/starbridge.new
if [ -d /opt/starbridge ]; then mv /opt/starbridge /opt/starbridge.old; fi
mv /opt/starbridge.new /opt/starbridge
REVISION=$rev SERVER_DIGEST=$server WEB_DIGEST=$web /opt/starbridge/deploy/host/apply.sh
# Only once it is up and healthy: a failed deploy leaves no REVISION, so only main's head deploys
# next, and the check above never trusts a release that never ran.
echo "$rev" > /opt/starbridge/REVISION
