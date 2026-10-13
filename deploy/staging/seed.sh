#!/bin/sh
# From the dev box: fills staging with synthetic users, each made through the real sign-in and
# pairing flows by the load test's setup (evals/load/setup.ts): a phone, a machine and a page.
# Staging holds no copy of prod's data (spec/releases.md). While it runs, staging's server is
# down and a seeding server holds its database (seed-host.sh). The users' sessions and keys go to
# $LOAD_DIR/users.jsonl, by default .scratch/staging-seed in the repository.
#   deploy/staging/seed.sh [USERS]     default 200; a second run adds only what is missing
set -eu
host=${STAGING_HOST:-sb-staging}
users=${1:-200}
repo=$(git rev-parse --show-toplevel)
export LOAD_DIR=${LOAD_DIR:-$repo/.scratch/staging-seed}
mkdir -p "$LOAD_DIR"
[ -e "$LOAD_DIR/fcm.pem" ] ||
  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$LOAD_DIR/fcm.pem" 2>/dev/null)
remote="sudo /opt/starbridge-staging/deploy/staging/seed-host.sh"

trap 'ssh "$host" "$remote stop"' EXIT
ssh "$host" "$remote start" < "$LOAD_DIR/fcm.pem"
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:28080:127.0.0.1:18080 "$host" &
tunnel=$!
trap 'kill $tunnel 2>/dev/null; ssh "$host" "$remote stop"' EXIT
sleep 2
# The fake's address as the seeding server reaches it, on staging's network.
bun "$repo/evals/load/setup.ts" --users "$users" --server http://127.0.0.1:28080 --fake http://sb-seed-fake:18099
