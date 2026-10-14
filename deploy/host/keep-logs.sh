#!/bin/sh
# keep-logs.sh NAME COMMAND...: what COMMAND prints, a failed service's logs during a deploy. Logs
# can hold account ids and push endpoints, and a deploy from Actions prints into the run's public
# log, so they go to a file only root can read, under /var/log/starbridge-deploy, and only its path
# is printed. DEPLOY_LOGS=stderr prints them instead: the owner's deploy.sh sets it.
set -eu
name=$1
shift
if [ "${DEPLOY_LOGS:-}" = stderr ]; then
  "$@" >&2 || true
  exit 0
fi
umask 077
dir=/var/log/starbridge-deploy
mkdir -p $dir
find $dir -name '*.log' -mtime +14 -delete 2>/dev/null || true
out=$dir/$name-$(date -u +%Y%m%dT%H%M%SZ).log
"$@" > "$out" 2>&1 || true
echo "$name's last logs are on the box, in $out" >&2
