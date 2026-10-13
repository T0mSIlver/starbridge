#!/bin/sh
# From the dev box: fills staging with synthetic users, each made through the real sign-in and
# pairing flows by the load test's setup (evals/load/setup.ts): a phone, a machine and a page.
# Staging holds no copy of prod's data (spec/releases.md). While it runs, staging's server is
# stopped and a second one runs on its database, signing in against the load test's fake GitHub
# and FCM (evals/load/fake.ts) on the VM; the users it made are listed in $LOAD_DIR/users.jsonl.
#   deploy/staging/seed.sh [USERS]     default 200; a second run adds only what is missing
set -eu
host=${STAGING_HOST:-sb-staging}
users=${1:-200}
repo=$(git rev-parse --show-toplevel)
export LOAD_DIR=${LOAD_DIR:-$repo/.scratch/staging-seed}
mkdir -p "$LOAD_DIR"
dir=/opt/starbridge-staging
compose="docker compose -p starbridge-staging -f $dir/deploy/compose.yaml -f $dir/deploy/staging/compose.yaml"
image="ghcr.io/t0msilver/starbridge-server:\$(cat $dir/REVISION)"
[ -e "$LOAD_DIR/fcm.pem" ] ||
  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$LOAD_DIR/fcm.pem" 2>/dev/null)
fcm=$(awk '{printf "%s\\n", $0}' "$LOAD_DIR/fcm.pem")
fake=http://sb-seed-fake:18099

cleanup() {
  ssh "$host" "sudo docker rm -f sb-seed-server sb-seed-fake >/dev/null 2>&1; sudo $compose up -d server" || true
}
trap cleanup EXIT
ssh "$host" "sudo sh -euc '
  $compose stop server
  docker rm -f sb-seed-server sb-seed-fake >/dev/null 2>&1 || true
  docker run -d --name sb-seed-fake --network starbridge-staging_default \
    -v $dir/evals/load/fake.ts:/fake.ts:ro --entrypoint bun $image /fake.ts --host 0.0.0.0 >/dev/null
  docker run -d --name sb-seed-server --network starbridge-staging_default -p 127.0.0.1:18080:8080 \
    -v starbridge-staging_data:/data -e PUBLIC_URL=https://staging.starbridge.run -e TRUST_PROXY=1 \
    -e ALLOW_PRIVATE_PUSH_ENDPOINTS=1 -e GITHUB_CLIENT_ID=seed -e GITHUB_CLIENT_SECRET=seed \
    -e GITHUB_AUTHORIZE_URL=$fake/login/oauth/authorize -e GITHUB_TOKEN_URL=$fake/login/oauth/access_token \
    -e GITHUB_API_URL=$fake -e FCM_PROJECT_ID=seed -e FCM_CLIENT_EMAIL=seed@seed.iam.gserviceaccount.com \
    -e FCM_PRIVATE_KEY=\"$fcm\" -e FCM_TOKEN_URL=$fake/token -e FCM_API_URL=$fake \
    -e VAPID_PUBLIC_KEY -e VAPID_PRIVATE_KEY $image >/dev/null
  for _ in \$(seq 30); do curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1 && exit 0; sleep 1; done
  docker logs --tail 30 sb-seed-server >&2; exit 1
'"
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:28080:127.0.0.1:18080 "$host" &
tunnel=$!
trap 'kill $tunnel 2>/dev/null; cleanup' EXIT
sleep 2
(cd "$repo" && bun evals/load/setup.ts --users "$users" --server http://127.0.0.1:28080 --fake "$fake")
