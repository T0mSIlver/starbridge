#!/bin/sh
# Run as root on homelab-arm by seed.sh: `seed-host.sh start` stops staging's server and starts a
# second one on its database that signs in against the load test's fake GitHub and FCM
# (evals/load/fake.ts), on 127.0.0.1:18080; `seed-host.sh stop` removes both and starts staging's
# server again. The fake FCM key comes on stdin.
set -eu
dir=/opt/starbridge-staging
compose="docker compose -p starbridge-staging -f $dir/deploy/compose.yaml -f $dir/deploy/staging/compose.yaml"
# The image apply.sh deployed.
image=ghcr.io/t0msilver/starbridge-server:$(sed -n 's/^REVISION=//p' $dir/deploy/.env)
fake=http://sb-seed-fake:18099
s=/etc/starbridge-staging/secrets

case ${1:-} in
start)
  # Not during a deploy; a deploy that starts later sees the seeding server and stops.
  exec 9>/run/starbridge-staging-deploy.lock
  flock -n 9 || { echo "seed-host.sh: a staging deploy is running; try again" >&2; exit 1; }
  fcm=$(awk '{printf "%s\\n", $0}')
  $compose stop server
  docker rm -f sb-seed-server sb-seed-fake >/dev/null 2>&1 || true
  docker run -d --name sb-seed-fake --network starbridge-staging_default \
    -v $dir/evals/load/fake.ts:/fake.ts:ro --entrypoint bun "$image" /fake.ts --host 0.0.0.0 >/dev/null
  # No relay: the server refuses it beside private push hosts, which the fake needs.
  docker run -d --name sb-seed-server --network starbridge-staging_default -p 127.0.0.1:18080:8080 \
    -v starbridge-staging_data:/data \
    -e PUBLIC_URL=https://staging.starbridge.run -e TRUST_PROXY=1 -e ALLOW_PRIVATE_PUSH_ENDPOINTS=1 \
    -e GITHUB_CLIENT_ID=seed -e GITHUB_CLIENT_SECRET=seed \
    -e GITHUB_AUTHORIZE_URL=$fake/login/oauth/authorize -e GITHUB_TOKEN_URL=$fake/login/oauth/access_token \
    -e GITHUB_API_URL=$fake -e FCM_PROJECT_ID=seed -e FCM_CLIENT_EMAIL=seed@seed.iam.gserviceaccount.com \
    -e "FCM_PRIVATE_KEY=$fcm" -e FCM_TOKEN_URL=$fake/token -e FCM_API_URL=$fake \
    -e "VAPID_PUBLIC_KEY=$(cat $s/vapid-public-key)" -e "VAPID_PRIVATE_KEY=$(cat $s/vapid-private-key)" \
    "$image" >/dev/null
  for _ in $(seq 30); do
    curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1 && exit 0
    sleep 1
  done
  docker logs --tail 30 sb-seed-server >&2
  exit 1
  ;;
stop)
  docker rm -f sb-seed-server sb-seed-fake >/dev/null 2>&1 || true
  $compose up -d server
  ;;
*) echo "usage: seed-host.sh start|stop" >&2; exit 2 ;;
esac
