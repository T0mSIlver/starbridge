#!/bin/sh
# keep-logs.sh NAME COMMAND...: what COMMAND prints, a failed service's logs during a deploy. Logs
# can hold account ids and push endpoints, and a deploy from Actions prints into the run's public
# log, so they go to a file only root can read, under /var/log/starbridge-deploy, and only its path
# is printed. DEPLOY_LOGS=stderr prints them instead: the owner's deploy.sh sets it. A file is
# read once, after the failed run, so every deploy deletes the ones older than 2 days (--prune,
# from apply.sh), which /privacy says. KEEP_LOGS_DIR is for the test.
set -eu
dir=${KEEP_LOGS_DIR:-/var/log/starbridge-deploy}
if [ "${1:-}" = --prune ]; then
  find "$dir" -name '*.log' -mtime +1 -delete 2>/dev/null || true
  exit 0
fi
name=$1
shift
if [ "${DEPLOY_LOGS:-}" = stderr ]; then
  "$@" >&2 || true
  exit 0
fi
umask 077
mkdir -p "$dir"
out="$dir/$name-$(date -u +%Y%m%dT%H%M%SZ).log"
"$@" > "$out" 2>&1 || true
echo "$name's last logs are on the box, in $out" >&2
