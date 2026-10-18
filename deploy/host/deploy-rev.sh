#!/bin/sh
# A box's deploy command, run as root by the forced commands of two Actions keys with a commit id:
# /usr/local/sbin/starbridge-deploy on prod, /usr/local/sbin/starbridge-staging-deploy on
# sb-staging. host/apply.sh and setup-actions-deploy.sh install it with the box's settings ahead
# of this file (host/prod.env, staging/staging.env).
#   <command> <commit>              the deploy key: main's head, or a commit on main that contains
#                                   the one deployed now
#   <command> --rollback <commit>   the rollback key: a commit this box ran before (#1828), listed
#                                   in $deployed below
# Either way only a commit on main, which it fetches itself, and only once it passed GATE (below).
# So a leaked deploy key can neither deploy a branch, roll back to an older, weaker release, nor
# skip the gate, and a leaked rollback key can only go back to a release that ran here. Deploys
# around these checks are the owner's, with deploy/deploy.sh.
set -eu
: "${COMMAND:?installed with a box's settings ahead of it (host/apply.sh)}"
usage() { echo "usage: $COMMAND [--rollback] <40-hex commit id>" >&2; exit 2; }
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

exec 9>/run/$COMMAND.lock
flock 9

state=/var/lib/$PROJECT
repo=$state/repo.git
mkdir -p $state
if [ -n "$GITHUB_KEY" ]; then
  # GitHub's published host key (docs.github.com, "GitHub's SSH key fingerprints"), not whichever
  # key the first fetch on a new box happens to see: what it fetches runs as root.
  known=$state/github_known_hosts
  echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > $known
  export GIT_SSH_COMMAND="ssh -i $GITHUB_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$known -o StrictHostKeyChecking=yes"
  url=git@github.com:T0mSIlver/starbridge.git
else
  # The repository is public.
  url=https://github.com/T0mSIlver/starbridge.git
fi
[ -d $repo ] || git init -q --bare $repo
git -C $repo fetch -q $url +main:main
git -C $repo merge-base --is-ancestor "$rev" main || { echo "$rev is not on main" >&2; exit 1; }
dir=/opt/$PROJECT
current=$(cat $dir/REVISION 2>/dev/null || true)
# Every commit this box ran, one per line: what --rollback may go back to.
deployed=$state/deployed
record() {
  case $1 in *[!0-9a-f]* | "") return 0 ;; esac
  [ ${#1} -eq 40 ] || return 0
  grep -qxF "$1" $deployed 2>/dev/null || echo "$1" >> $deployed
}
if [ -n "$rollback" ]; then
  grep -qxF "$rev" $deployed 2>/dev/null || { echo "$LABEL never ran $rev; not rolled back" >&2; exit 1; }
  [ "$rev" != "$current" ] || { echo "$LABEL already runs $rev"; exit 0; }
# CI on an older commit of main can finish after a newer one deployed, and its server would
# refuse a database the newer one migrated: that run deploys nothing.
elif [ "$rev" != "$(git -C $repo rev-parse main)" ] &&
  ! git -C $repo merge-base --is-ancestor "$current" "$rev" 2>/dev/null; then
  echo "$rev is older than the deployed ${current:-release} and is not main's head; not deployed"
  exit 0
fi

# GitHub's public API, without a token: the repository is public, so the box holds no GitHub
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
digests=
case $GATE in
ci)
  # CI passed this commit on a push to main (#1714). deploy.yml deploys only such a commit; the
  # box checks again, so the deploy key alone cannot ship one that failed. Only main's pushes make
  # such runs of ci.yml.
  get "actions/workflows/ci.yml/runs?head_sha=$rev&event=push&branch=main&status=success&per_page=10" |
    jq -e --arg rev "$rev" 'any(.workflow_runs[]; .path == ".github/workflows/ci.yml" and .event == "push"
      and .head_branch == "main" and .head_sha == $rev and .conclusion == "success"
      and .head_repository.full_name == "T0mSIlver/starbridge")' >/dev/null ||
    { echo "CI has not passed $rev on main; not deployed" >&2; exit 1; }
  echo "CI passed $rev on main"
  # seed.sh's seeding server holds the database meanwhile (staging/seed-host.sh).
  if [ -n "$(docker ps -q -f name='^sb-seed-server$')" ]; then
    echo "$LABEL is being seeded; not deployed" >&2
    exit 1
  fi
  ;;
staging)
  # Staging passed this commit (#1528, #1714). deploy.yml checks it before it calls this command;
  # the box checks again, so the Actions key alone cannot skip staging. Any workflow can post a
  # commit status, so the status only points at its run: that run must be main's deploy.yml, and
  # its staging job must have run the step named "Staging passed <this commit>", which only a pass
  # runs.
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
  export SERVER_DIGEST=$server WEB_DIGEST=$web
  ;;
*) echo "$COMMAND: no gate named $GATE; not deployed" >&2; exit 1 ;;
esac

# The running commit goes on the record first, so the first deploy by this script makes the
# release before it one to go back to. One the owner deployed around these checks is recorded too;
# --rollback still checks it as above.
record "$current"
# apply.sh installs its own tree's deploy command, and an older tree's may not know --rollback:
# after a rollback, failed or not, this command comes back, so the next rollback still works and
# the command never goes back to older checks.
if [ -n "$rollback" ]; then
  self=$(mktemp)
  cp /usr/local/sbin/$COMMAND "$self"
  trap 'install -m 755 -o root -g root "$self" /usr/local/sbin/$COMMAND; rm -f "$self"' EXIT
fi

rm -rf $dir.new $dir.old
mkdir $dir.new
git -C $repo archive --format=tar "$rev" | tar -x -C $dir.new
if [ -d $dir ]; then mv $dir $dir.old; fi
mv $dir.new $dir
REVISION=$rev $dir/$APPLY
# Only once it is up and healthy: a failed deploy leaves no REVISION, so only main's head or a
# rollback deploys next, and neither check above trusts a release that never ran.
echo "$rev" > $dir/REVISION
record "$rev"
# Then one round trip on the box's test account (#1528): a card, its Web Push, an answer read
# back, from the outside check's instance on the box (starbridge-planning, infra/sb-staging). Its
# failure fails the deploy, and prod waits for staging's (deploy.yml). Until that instance is set
# up, it says so and passes.
if [ -n "$ROUND_TRIP" ]; then
  if [ -x /usr/local/sbin/sb-check-now ] && [ "$(cat $ROUND_TRIP/setup-state 2>/dev/null)" = done ]; then
    /usr/local/sbin/sb-check-now $ROUND_TRIP
  else
    echo "no round trip: the $LABEL check is not set up"
  fi
fi
# Then the Play reviewers' demo server, from this checkout, only after the round trip passed: a
# project of its own, which restarts only when its code changed (host/demo.sh). Its failure is
# reported but blocks no release, and a cold build (about 5 minutes on sb-staging) is cut at 8,
# inside the staging job's limit (deploy.yml).
if [ -n "$DEMO" ]; then
  timeout 480 $dir/deploy/host/demo.sh || echo "the demo server did not deploy; see above" >&2
fi
# The last line deploy.yml reads from staging: only a commit that went through all of the above
# lets prod deploy it. A skipped older commit ends without it.
echo "passed $rev"
