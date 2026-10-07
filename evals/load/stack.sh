#!/bin/sh
# Prod's stack on this machine for the load and failure tests (README.md). Usage:
#   evals/load/stack.sh up        build and start it; Caddy on http://127.0.0.1:18000
#   evals/load/stack.sh load …    run load.ts against it, from a container on its network
#   evals/load/stack.sh spike …   run spike.ts the same way
#   evals/load/stack.sh deploy    roll it out again under load, as deploy/host/apply.sh does
#   evals/load/stack.sh small-disk [MB]  move the server's data to an MB-sized tmpfs (sudo)
#   evals/load/stack.sh big-disk  back to its volume, unmounting the small disk
#   evals/load/stack.sh down      stop it and delete its volumes
#   evals/load/stack.sh compose … any docker compose command on it
# LOAD_DIR (default .scratch/load in the repository) holds its fake secrets, its Caddyfile and the
# load script's users. It never talks to starbridge.run.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
export LOAD_DIR="${LOAD_DIR:-$repo/.scratch/load}"
# The fakes (fake.ts) listen on Docker's default bridge, which containers reach as
# host.docker.internal.
gw=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
fake="http://host.docker.internal:18099"
compose() {
  docker compose -p starbridge-load --project-directory "$repo/deploy" \
    -f "$repo/deploy/compose.yaml" -f "$here/compose.yaml" ${LOAD_EXTRA:+-f "$LOAD_EXTRA"} "$@"
}

secrets() {
  mkdir -p "$LOAD_DIR"
  umask 077
  [ -e "$LOAD_DIR/fcm.pem" ] ||
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$LOAD_DIR/fcm.pem" 2>/dev/null
  [ -e "$LOAD_DIR/vapid.json" ] ||
    (cd "$repo/server" && bun -e 'console.log(JSON.stringify(require("web-push").generateVAPIDKeys()))') \
      > "$LOAD_DIR/vapid.json"
  {
    echo "PUBLIC_URL=http://localhost:18000"
    echo "TRUST_PROXY=1"
    echo "RELAY_MODE=1"
    echo "ALLOW_PRIVATE_PUSH_ENDPOINTS=1"
    echo "GITHUB_CLIENT_ID=load"
    echo "GITHUB_CLIENT_SECRET=load"
    echo "GITHUB_AUTHORIZE_URL=$fake/login/oauth/authorize"
    echo "GITHUB_TOKEN_URL=$fake/login/oauth/access_token"
    echo "GITHUB_API_URL=$fake"
    echo "FCM_PROJECT_ID=load"
    echo "FCM_CLIENT_EMAIL=load@load.iam.gserviceaccount.com"
    echo "FCM_PRIVATE_KEY='$(awk '{printf "%s\\n", $0}' "$LOAD_DIR/fcm.pem")'"
    echo "FCM_TOKEN_URL=$fake/token"
    echo "FCM_API_URL=$fake"
    echo "VAPID_PUBLIC_KEY=$(jq -r .publicKey "$LOAD_DIR/vapid.json")"
    echo "VAPID_PRIVATE_KEY=$(jq -r .privateKey "$LOAD_DIR/vapid.json")"
    echo "VAPID_SUBJECT=mailto:load@localhost"
  } > "$LOAD_DIR/server.env"
  [ -e "$LOAD_DIR/umami-db.env" ] || {
    pw=$(openssl rand -hex 16)
    echo "POSTGRES_PASSWORD=$pw" > "$LOAD_DIR/umami-db.env"
    printf 'DATABASE_URL=postgresql://umami:%s@umami-db:5432/umami\nAPP_SECRET=%s\n' \
      "$pw" "$(openssl rand -hex 16)" > "$LOAD_DIR/umami.env"
  }
  # Prod's Caddyfile, served on plain HTTP at :18000 inside the compose network: the upstreams
  # by service name, and the admin API open to the published port. The client's address, which
  # the server's and Umami's per-address limits key on, is the X-Sim-IP header spike.ts sends
  # for each visitor; without it the server sees Caddy's own address, as before.
  sed -e 's/^starbridge\.run {/http:\/\/:18000 {/' -e 's/^\tservers {/\tadmin 0.0.0.0:2019\n\tservers {/' \
    -e 's/127\.0\.0\.1:8080/server:8080/; s/127\.0\.0\.1:3001/umami:3000/' \
    -e 's/127\.0\.0\.1:3010/web-a:3000/; s/127\.0\.0\.1:3011/web-b:3000/' \
    -e 's/^\(\t*\)reverse_proxy server:8080 {/&\n\1\theader_up X-Forwarded-For {http.request.header.X-Sim-IP}/' \
    -e 's/key {http\.request\.remote\.host}/key {http.request.header.X-Sim-IP}/' \
    "$repo/deploy/Caddyfile" > "$LOAD_DIR/Caddyfile"
  chmod 644 "$LOAD_DIR/Caddyfile"
  # The stats host's password block, with prod's fallback hash: nobody holds its password.
  mkdir -p "$LOAD_DIR/caddy"
  printf 'import stats_gate %s none\n' \
    "$(sed -n "s/^hash='\(.*\)'\$/\1/p" "$repo/deploy/host/caddy-auth.sh")" > "$LOAD_DIR/caddy/stats-auth"
}

healthy() {
  for _ in $(seq "${3:-60}"); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$2 not healthy" >&2
  return 1
}

case "${1:-}" in
up)
  secrets
  echo "fakes: run 'bun evals/load/fake.ts --host $gw' before load"
  compose build server web-a caddy
  compose up -d server web-a umami umami-db caddy
  healthy http://127.0.0.1:18000/healthz server
  healthy http://127.0.0.1:18000/ web-a
  # The website the landing page reports to (web/src/lib/analytics.ts), or Umami refuses every
  # event with a 400. A fresh Umami still has its default login.
  site=$(sed -n 's/^export const WEBSITE_ID = "\(.*\)";$/\1/p' "$repo/web/src/lib/analytics.ts")
  [ -n "$site" ] || { echo "no WEBSITE_ID in web/src/lib/analytics.ts" >&2; exit 1; }
  added=
  for _ in $(seq 60); do
    compose exec -T -e SITE="$site" umami node -e '
const url = "http://localhost:3000/api";
const json = { "content-type": "application/json" };
(async () => {
  const { token } = await (await fetch(`${url}/auth/login`, { method: "POST", headers: json,
    body: JSON.stringify({ username: "admin", password: "umami" }) })).json();
  const auth = { ...json, authorization: `Bearer ${token}` };
  // An unknown website reads as 200 and null.
  const had = await fetch(`${url}/websites/${process.env.SITE}`, { headers: auth });
  if (had.ok && (await had.json())) return;
  const r = await fetch(`${url}/websites`, { method: "POST", headers: auth,
    body: JSON.stringify({ id: process.env.SITE, name: "starbridge.run", domain: "starbridge.run" }) });
  if (!r.ok) throw new Error(`umami: ${r.status}`);
})().catch((e) => { console.error(String(e)); process.exit(1); });' 2>/dev/null && added=1 && break
    sleep 1
  done
  [ -n "$added" ] || { echo "Umami: could not add the website" >&2; exit 1; }
  echo "stack up: http://127.0.0.1:18000 (server 18080, web 13010/13011, Caddy admin 12019)"
  ;;
deploy)
  # deploy/host/apply.sh's rollout, step for step, minus the host's systemd units and secrets:
  # start the idle web copy, wait for it, reload Caddy, stop the live copy, restart the server.
  if [ -n "$(compose ps -q --status running web-a)" ]; then
    live=web-a next=web-b port=13011
  else
    live=web-b next=web-a port=13010
  fi
  compose up -d --no-deps --force-recreate $next
  healthy http://127.0.0.1:$port/ $next 30 || { compose stop $next; exit 1; }
  curl -fsS --retry 10 --retry-connrefused --retry-delay 1 -X POST \
    -H 'Content-Type: text/caddyfile' --data-binary @"$LOAD_DIR/Caddyfile" http://127.0.0.1:12019/load
  sleep 2
  compose stop $live
  compose up -d --force-recreate --no-deps server
  healthy http://127.0.0.1:18080/healthz server 30
  echo "deployed: $live -> $next, server restarted"
  ;;
small-disk)
  # A size-capped tmpfs: writes past it fail with ENOSPC, as on a full disk. (A loop-mounted
  # ext4 would be closer, but containers like LXC have no loop devices.)
  mountpoint -q "$LOAD_DIR/disk" 2>/dev/null && { echo "already on a small disk: big-disk first" >&2; exit 1; }
  compose stop server
  mkdir -p "$LOAD_DIR/disk"
  sudo mount -t tmpfs -o "size=${2:-256}m" tmpfs "$LOAD_DIR/disk"
  vol=$(docker volume inspect -f '{{.Mountpoint}}' starbridge-load_data)
  sudo cp -a "$vol/." "$LOAD_DIR/disk/"
  sudo chown -R 1000:1000 "$LOAD_DIR/disk"
  LOAD_EXTRA="$here/small-disk.yaml" compose up -d server
  healthy http://127.0.0.1:18080/healthz server 30
  df -h "$LOAD_DIR/disk"
  ;;
big-disk)
  compose stop server
  ! mountpoint -q "$LOAD_DIR/disk" 2>/dev/null || sudo umount "$LOAD_DIR/disk"
  compose up -d server
  healthy http://127.0.0.1:18080/healthz server 30
  ;;
load | spike)
  # load.ts or spike.ts in its own container on the stack's network, so its sockets stay out of the
  # machine's port range. It reads the containers' stats from the host's cgroups and the
  # Docker socket. Paths it takes (--until, --out) are under /load, which is LOAD_DIR.
  script=$1
  shift
  docker run --rm -i --name "starbridge-$script-client" ${LOAD_CLIENT_CPUS:+--cpuset-cpus "$LOAD_CLIENT_CPUS"} --network starbridge-load_default \
    --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
    -v "$repo:/repo:ro" -v "$LOAD_DIR:/load" -e LOAD_DIR=/load ${LOAD_TARGET:+-e LOAD_TARGET="$LOAD_TARGET"} \
    -e BUN_CONFIG_MAX_HTTP_REQUESTS=65535 \
    -v /sys/fs/cgroup:/host/cgroup:ro -e LOAD_CGROUPS=/host/cgroup \
    -v /var/run/docker.sock:/var/run/docker.sock --ulimit nofile=524288:524288 \
    oven/bun:1.4.2 bun "/repo/evals/load/$script.ts" "$@"
  ;;
down) compose down -v ;;
compose) shift; compose "$@" ;;
*) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
