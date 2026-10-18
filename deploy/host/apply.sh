#!/bin/sh
# Run as root on a box once a commit is unpacked into /opt/<project>: by the deploy command
# (host/deploy-rev.sh), and on prod by the owner's deploy/deploy.sh. One script for both boxes;
# DEPLOY_ENV names the box's settings, relative to deploy/: host/prod.env (the default) or
# staging/staging.env, which staging/apply.sh passes.
set -eu
cd "$(dirname "$0")/.."
DEPLOY_ENV=${DEPLOY_ENV:-host/prod.env}
. "./$DEPLOY_ENV"
compose="docker compose -p $PROJECT $COMPOSE_FILES"
etc=/etc/$PROJECT
# The commit, built into the server for /healthz. An older deploy command passes none and writes
# REVISION before this runs.
export REVISION=${REVISION:-$(cat /opt/$PROJECT/REVISION 2>/dev/null || echo unknown)}
# The server and web images are deploy.yml's, tagged by this commit (#1518). A commit that has
# none, from before them or never deployed from main, stops at their pull below, before any
# container is replaced.
case $REVISION in *[!0-9a-f]*) REVISION= ;; esac
[ ${#REVISION} -eq 40 ] || { echo "apply.sh: REVISION is not a commit id" >&2; exit 1; }
# The server and web images by digest (host/images.sh): on prod staging's, from the deploy
# command, or the tag's. Compose reads them from here, so every script on the box that runs it
# names this release.
images=$(host/images.sh)
{
  echo "REVISION=$REVISION"
  printf '%s\n' "$images" | while read -r image digest; do
    echo "$(echo "$image" | tr a-z A-Z)_IMAGE=ghcr.io/t0msilver/starbridge-$image:$REVISION@$digest"
  done
} > .env
# deploy.yml reads staging's `image` lines and names the digests in the run, and prod deploys
# those (#1715).
printf '%s\n' "$images" | sed 's/^/image /'

if [ -n "$BACKUPS" ]; then
  install -m 644 host/starbridge-backup.service host/starbridge-backup.timer host/starbridge-offsite.service \
    host/starbridge-umami-trim.service host/starbridge-umami-trim.timer \
    host/starbridge-docker-prune.service host/starbridge-docker-prune.timer /etc/systemd/system/
  systemctl daemon-reload
  # The offsite backup's tools, on a host set up before it (#1482).
  command -v age >/dev/null && command -v zstd >/dev/null && command -v rsync >/dev/null ||
    DEBIAN_FRONTEND=noninteractive apt-get install -yq age zstd rsync
  systemctl enable --now starbridge-backup.timer starbridge-umami-trim.timer starbridge-docker-prune.timer
fi
# The next deploy runs this commit's deploy command, with this box's settings ahead of it.
command=$(mktemp)
{
  echo '#!/bin/sh'
  cat "$DEPLOY_ENV"
  cat host/deploy-rev.sh
} > "$command"
install -m 755 "$command" /usr/local/sbin/$COMMAND
rm -f "$command"

DEPLOY_ENV=$DEPLOY_ENV host/server-env.sh
[ -z "$UMAMI" ] || host/umami-env.sh
# A box other than starbridge.run serves prod's Caddyfile under its own name, as
# evals/load/stack.sh rewrites it: the stats host on plain HTTP on the box's loopback only, prod's
# demo host replaced by the demo's own block, and nothing indexed.
caddyfile=Caddyfile
if [ "$SITE" != starbridge.run ]; then
  caddyfile=$etc/Caddyfile
  sed -e "s/^starbridge\.run {/$SITE {\n\theader X-Robots-Tag \"noindex, nofollow\"/" \
    -e 's/^stats\.starbridge\.run {/http:\/\/127.0.0.1:18001 {\n\tbind 127.0.0.1/' -e '/^demo\.starbridge\.run {/,/^}/d' \
    Caddyfile > $caddyfile
  # The Play reviewers' demo server (demo/demo.caddy, #1557).
  [ -z "$DEMO" ] || { echo; cat demo/demo.caddy; } >> $caddyfile
  chmod 644 $caddyfile
fi
# The stats host's password; a box with none pushed keeps it shut.
host/caddy-auth.sh $etc/caddy
# The denylist's snippet, which the Caddyfile imports (host/switch.sh).
[ -z "$DENYLIST" ] || host/switch.sh --regenerate
# Caddy's image changes only when caddy.Dockerfile does: a new image recreates the container,
# which drops every open connection. Its build is not reproducible (xcaddy fetches and compiles
# afresh once the build cache is pruned), so it is tagged by a hash of the Dockerfile, which pins
# every input, and built only when no image has that tag.
caddy=starbridge-caddy:$(sha256sum caddy.Dockerfile | cut -c1-16)
if ! docker image inspect "$caddy" >/dev/null 2>&1; then
  $compose build caddy
  docker tag starbridge-caddy:latest "$caddy"
fi
docker tag "$caddy" starbridge-caddy:latest

# up ARGS: `$compose up ARGS`, once more when Docker fails a recreate with "removal of container
# <id> is already in progress" while it still removes the container compose just stopped. Nothing
# else touched the container when that failed a staging deploy (#1663, #1674); a second `up` after
# the removal succeeds.
up() {
  log=$(mktemp)
  if $compose up "$@" 2>"$log"; then
    cat "$log" >&2
    rm -f "$log"
    return 0
  fi
  cat "$log" >&2
  removing=$(sed -n 's/.*removal of container \([0-9a-f]*\) is already in progress.*/\1/p' "$log" | head -n 1)
  rm -f "$log"
  [ -n "$removing" ] || return 1
  echo "apply.sh: Docker is still removing container $removing; trying again once it is gone" >&2
  for _ in $(seq 30); do
    docker container inspect "$removing" >/dev/null 2>&1 || break
    sleep 1
  done
  $compose up "$@"
}

# healthy URL SERVICE [SECONDS]
healthy() {
  for _ in $(seq "${3:-$HEALTH_WAIT}"); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$2 not healthy after ${3:-$HEALTH_WAIT} s" >&2
  host/keep-logs.sh "$2" $compose logs --tail 50 "$2"
  return 1
}

# The schema the new server migrates to, and the one the database is at. A database the new server
# would refuse at start stops the deploy here, before anything is replaced (`schema check`,
# server/src/db.ts): one newer than the server, except by one additive migration (#1555), so a
# rollback one release back passes. Nothing copies or migrates a database down; past that, the
# owner restores the deploy's backup.
mnt= db= want= have=
if [ -n "$BACKUPS" ]; then
  mnt=$(docker volume inspect -f '{{.Mountpoint}}' ${PROJECT}_data 2>/dev/null) || mnt=
  db=$mnt/starbridge.db
fi
if [ -n "$mnt" ] && [ -f "$db" ]; then
  want=$($compose run --rm --no-deps -T server bun server.js schema 2>/dev/null) || want=
  have=$(sqlite3 -readonly "$db" 'PRAGMA user_version' 2>/dev/null) || have=
  # sqlite3 runs as root, so hand back any WAL or shared-memory file it made, or the server
  # could no longer write the database.
  chown --reference="$db" "$db"-wal "$db"-shm 2>/dev/null || true
fi
if [ -n "$mnt" ] && [ -f "$db" ]; then
  # The server prints its verdict on stdout; Compose's progress goes to stderr.
  check=$($compose run --rm --no-deps -T server bun server.js schema check 2>/dev/null) && ok=1 || ok=
  check=$(printf '%s\n' "$check" | tail -n 1)
  case $check in
  ok) ;;
  # A server from before `schema check` prints its version and exits 0: compare as it would.
  [0-9]*)
    if [ -n "$have" ] && [ "$have" -gt "$check" ] 2>/dev/null; then
      echo "apply.sh: $db is at schema $have, newer than this server's $check; nothing deployed." >&2
      exit 1
    fi
    ;;
  *)
    [ -n "$ok" ] || { echo "apply.sh: $check; nothing deployed." >&2; exit 1; }
    ;;
  esac
fi

web=web-a
if [ "$WEB_COPIES" = 2 ]; then
  # No request fails during a deploy (#150). The page runs as two copies: start the idle one, wait
  # for its health, then stop the live one; Caddy sends requests to the first healthy copy.
  web=
  if [ -n "$($compose ps -q --status running web-a)" ]; then
    live=web-a next=web-b port=3011
  else
    live=web-b next=web-a port=3010
  fi
  up -d --no-deps --force-recreate $next
  # A copy that never turns healthy is stopped, so the live one stays the only one running and a
  # retried deploy replaces the failed copy, not the live one.
  healthy http://127.0.0.1:$port/ $next || { $compose stop $next; exit 1; }

  # Caddy takes the Caddyfile through its admin API on every deploy: a reload keeps open
  # connections, where recreating the container would drop them, and an unchanged one is a no-op.
  # Loading each time, rather than when the file changed, also heals a load that failed before.
  up -d caddy
  host/caddy-load.sh $caddyfile
  # Caddy checks health every second: let it see the new copy before the old one goes. Requests
  # in flight at the stop are GETs, which Caddy retries on the new copy.
  sleep 2
  $compose stop $live
fi

# A backup before the new server opens the database and runs its migrations (#470), so a bad one
# rolls back to this deploy's data rather than the night's. The old server still runs, so writes
# in the seconds until it stops are not in it. A failed backup stops the deploy before the server
# is replaced: no migration runs without one. Only a deploy whose server migrates further than the
# database's `user_version` takes one; when either number can't be read, it takes one anyway. The
# last two are kept, each a full copy of the database on the same disk (#586), for 7 days at most
# (backup.sh, #721). A new host has no volume yet.
if [ -n "$BACKUPS" ]; then
  if [ -n "$mnt" ] && [ -f "$db" ] && ! { [ -n "$want" ] && [ "$want" = "$have" ]; }; then
    out=/var/backups/starbridge/deploy-$(date -u +%Y%m%dT%H%M%S).db
    mkdir -p /var/backups/starbridge
    # VACUUM INTO reads one snapshot while the server writes, and leaves free pages out. It
    # refuses a file that exists.
    rm -f "$out.tmp"
    (umask 077 && sqlite3 "$db" "VACUUM INTO '$out.tmp'")
    chown --reference="$db" "$db"-wal "$db"-shm 2>/dev/null || true
    sqlite3 "$out.tmp" 'PRAGMA integrity_check' | grep -qx ok
    mv "$out.tmp" "$out"
  fi
  ls -t /var/backups/starbridge/deploy-*.db 2>/dev/null | tail -n +3 | xargs -r rm -f
fi

# The server stays one instance: it holds the long-polls and SQLite. On SIGTERM it ends its
# long-polls and exits, and Caddy holds requests until the new one answers. --remove-orphans
# drops the single `web` of releases before two copies. One copy of the page restarts here.
up -d --remove-orphans server $web ${UMAMI:+umami umami-db} caddy

healthy http://127.0.0.1:8080/healthz server
if [ -n "$web" ]; then
  healthy http://127.0.0.1:3010/ web-a
  host/caddy-load.sh $caddyfile
fi
# Umami migrates its database on its first start.
[ -z "$UMAMI" ] || healthy http://127.0.0.1:3001/api/heartbeat umami 120

# /healthz/backup fails until a first backup ran; run one now rather than wait for the night. The
# new server already serves, so a failed one doesn't fail the deploy: the backup watcher alerts
# on the missing backup (#1217).
if [ -n "$BACKUPS" ]; then
  [ -e "$(docker volume inspect -f '{{.Mountpoint}}' ${PROJECT}_data)/last-backup" ] ||
    systemctl start starbridge-backup.service || echo "apply.sh: the first backup failed" >&2
fi

# Cleanup last, and never a reason to fail a deploy that is already serving. Each build leaves
# about 0.9 GB of cache; unpruned, a day of deploys left 27 GB of it on prod's 38 GB disk (#301).
# The newest BUILD_CACHE keeps the next build fast.
# The demo server moved to sb-staging (#1557): a copy another box ran goes, with its owner token.
if [ -z "$DEMO" ]; then
  old=$(docker ps -aq --filter label=com.docker.compose.project=starbridge-demo)
  [ -z "$old" ] || docker rm -f $old >/dev/null || true
  docker image rm starbridge-demo:latest >/dev/null 2>&1 || true
  rm -rf /etc/starbridge-demo
fi
docker image prune -f >/dev/null || true
# The newest 5 releases' images stay, for a rollback that needs no download; Docker refuses to
# remove the ones in use.
for image in server web; do
  docker image ls "ghcr.io/t0msilver/starbridge-$image" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' |
    sort -r | tail -n +6 | cut -f2 | xargs -r docker image rm >/dev/null 2>&1 || true
done
docker image ls starbridge-caddy --format '{{.Repository}}:{{.Tag}}' | grep -vx -e starbridge-caddy:latest -e "$caddy" |
  xargs -r docker image rm >/dev/null || true
docker builder prune -f --keep-storage $BUILD_CACHE >/dev/null || true
