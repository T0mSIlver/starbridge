#!/bin/sh
# Run as root on homelab-arm by starbridge-staging-deploy (deploy-rev.sh beside this file), once
# it unpacked a commit of main into /opt/starbridge-staging. Staging's part of host/apply.sh: the
# same images and Caddy as prod, its own secrets (server-env.sh), and no Umami, backups or demo
# server. The page runs as one copy, so a deploy may drop a request or two.
set -eu
cd /opt/starbridge-staging/deploy
compose="docker compose -p starbridge-staging -f compose.yaml -f staging/compose.yaml"
etc=/etc/starbridge-staging
case ${REVISION:-} in *[!0-9a-f]*) REVISION= ;; esac
[ ${#REVISION} -eq 40 ] || { echo "staging/apply.sh: REVISION is not a commit id" >&2; exit 1; }
export REVISION
echo "REVISION=$REVISION" > .env

staging/server-env.sh
# Prod's Caddyfile under staging's name, as evals/load/stack.sh rewrites it: the stats host on
# plain HTTP on the VM's loopback only, no demo host, and nothing indexed.
sed -e 's/^starbridge\.run {/staging.starbridge.run {\n\theader X-Robots-Tag "noindex, nofollow"/' \
  -e 's/^stats\.starbridge\.run {/http:\/\/127.0.0.1:18001 {\n\tbind 127.0.0.1/' -e '/^demo\.starbridge\.run {/,/^}/d' \
  Caddyfile > $etc/Caddyfile
chmod 644 $etc/Caddyfile
# Its stats host stays shut: no password is pushed here.
host/caddy-auth.sh $etc/caddy

# Images are tagged by commit and never change: one already here needs no download.
for image in server web; do
  docker image inspect "ghcr.io/t0msilver/starbridge-$image:$REVISION" >/dev/null 2>&1 ||
    docker pull -q "ghcr.io/t0msilver/starbridge-$image:$REVISION" >/dev/null
done
# As on prod: built only when no image has the tag of its Dockerfile's hash.
caddy=starbridge-caddy:$(sha256sum caddy.Dockerfile | cut -c1-16)
if ! docker image inspect "$caddy" >/dev/null 2>&1; then
  $compose build caddy
  docker tag starbridge-caddy:latest "$caddy"
fi
docker tag "$caddy" starbridge-caddy:latest

$compose up -d --remove-orphans server web-a caddy
healthy() {
  for _ in $(seq 60); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$2 not healthy after 60 s" >&2
  $compose logs --tail 50 "$2" >&2
  return 1
}
healthy http://127.0.0.1:8080/healthz server
healthy http://127.0.0.1:3010/ web-a
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 -X POST \
  -H 'Content-Type: text/caddyfile' --data-binary @$etc/Caddyfile http://127.0.0.1:2019/load

# The newest 5 releases' images stay, as on prod.
for image in server web; do
  docker image ls "ghcr.io/t0msilver/starbridge-$image" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' |
    sort -r | tail -n +6 | cut -f2 | xargs -r docker image rm >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null || true
docker builder prune -f --keep-storage 1GB >/dev/null || true
