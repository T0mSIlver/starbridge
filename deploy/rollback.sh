#!/bin/sh
# Rolls starbridge.run back to a release whose images the box still holds (host/apply.sh keeps
# the newest 5):
#   deploy/rollback.sh             the release before the running one
#   deploy/rollback.sh <commit>    that commit
#   deploy/rollback.sh --list      the releases the box holds, newest first
# It asks before deploying, unless given --yes. It deploys the commit's whole tree with
# deploy/deploy.sh, so its compose file, Caddyfile and demo server come back too. apply.sh refuses
# a database that server would refuse: newer than its schema, except by one additive migration
# (#1555). Rolling back further needs the backup taken before it (deploy/README.md, "Restore").
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
cd "$(git rev-parse --show-toplevel)"

yes= list= want=
for a in "$@"; do
  case $a in
  --yes) yes=1 ;;
  --list) list=1 ;;
  -*) echo "usage: deploy/rollback.sh [--list | [--yes] [<commit>]]" >&2; exit 2 ;;
  *) want=$a ;;
  esac
done

git fetch -q origin
# What the box runs, and the commits whose server and web images it holds.
state=$(ssh -i "$key" "$host" "cat /opt/starbridge/REVISION; for image in server web; do
  sudo docker image ls ghcr.io/t0msilver/starbridge-\$image --format \"\$image {{.Tag}}\"; done")
current=$(printf '%s\n' "$state" | head -n 1)
held=$(printf '%s\n' "$state" | awk '$1 == "server" { s[$2] = 1 } $1 == "web" && s[$2] { print $2 }' |
  grep -xE '[0-9a-f]{40}' || true)
# Newest first, by main's history; a commit not on main is no release.
held=$(git rev-list origin/main | grep -xF "$(printf '%s\n' "$held")" || true)

if [ -n "$list" ]; then
  for c in $held; do
    mark=
    [ "$c" = "$current" ] && mark=" (running)"
    echo "$(git log -1 --format='%h %cs %s' "$c")$mark"
  done
  exit 0
fi

if [ -n "$want" ]; then
  target=$(git rev-parse --verify -q "$want^{commit}") || { echo "unknown commit: $want" >&2; exit 1; }
  printf '%s\n' "$held" | grep -qxF "$target" || {
    echo "the box holds no images for $target; deploy/rollback.sh --list names those it holds" >&2
    exit 1
  }
else
  # The newest held release older than the running one.
  target=
  for c in $held; do
    [ "$c" != "$current" ] && git merge-base --is-ancestor "$c" "$current" 2>/dev/null && { target=$c; break; }
  done
  [ -n "$target" ] || { echo "the box holds no release older than ${current:-the running one}" >&2; exit 1; }
fi
[ "$target" != "$current" ] || { echo "starbridge.run already runs $target" >&2; exit 1; }

echo "starbridge.run runs  $(git log -1 --format='%h %cs %s' "$current" 2>/dev/null || echo "${current:-nothing}")"
echo "roll back to         $(git log -1 --format='%h %cs %s' "$target")"
if [ -z "$yes" ]; then
  printf 'Deploy it? [y/N] '
  read -r answer || answer=
  case $answer in y | Y | yes) ;; *) echo "not deployed"; exit 1 ;; esac
fi
exec deploy/deploy.sh "$target"
