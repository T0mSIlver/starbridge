#!/bin/sh
# Rehearses a deploy's migrations on prod's schema at prod's scale (README.md). Usage:
#   evals/migrate/rehearse.sh --schema FILE --from REV --to REV [--users N] [--decisions N] [--mb N] [--limit S]
# FILE is prod's schema export, with no rows; --from the commit prod runs, --to the candidate.
# Both servers come from ghcr.io by commit. Fails when prod's schema differs from what the
# migrations at --from make, when the candidate's server takes over --limit seconds (30, the time
# Caddy holds requests) to answer /healthz on the filled database, or when its migrated schema
# differs from what it makes from nothing. Prints one JSON line last and keeps it in
# $REHEARSE_DIR/result.json. Needs Docker; works in $REHEARSE_DIR (default .scratch/migrate).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dir=${REHEARSE_DIR:-$repo/.scratch/migrate}
schema= from= to= users=3000 decisions=20 mb=2048 limit=30
while [ $# -gt 0 ]; do
  case $1 in
    --schema) schema=$2 ;;
    --from) from=$2 ;;
    --to) to=$2 ;;
    --users) users=$2 ;;
    --decisions) decisions=$2 ;;
    --mb) mb=$2 ;;
    --limit) limit=$2 ;;
    *) echo "rehearse.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift 2
done
[ -f "$schema" ] && [ -n "$from" ] && [ -n "$to" ] || { sed -n 2,3p "$0" >&2; exit 2; }
for rev in "$from" "$to"; do
  case $rev in *[!0-9a-f]* | "") echo "rehearse.sh: $rev is not a commit id" >&2; exit 2 ;; esac
done
image=ghcr.io/t0msilver/starbridge-server
net=sb-rehearse
mkdir -p "$dir"
dir=$(cd "$dir" && pwd)
result=$dir/result.json
rm -f "$result"

# Ends the run: one JSON line, kept in result.json.
finish() { # OK DETAIL [MS]
  printf '{"ok":%s,"at":"%s","from":"%s","to":"%s","fromVersion":%s,"toVersion":%s,"ms":%s,"mb":%s,"detail":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$from" "$to" "${from_v:-null}" "${to_v:-null}" "${3:-null}" "$mb" \
    "$(printf '%s' "$2" | tr '\n"\\' "  /" | cut -c1-300)" | tee "$result"
  [ "$1" = true ] && exit 0
  exit 1
}
cleanup() {
  docker rm -f sb-rehearse-server sb-rehearse-fake >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
cleanup
docker network create "$net" >/dev/null

echo "[1/6] tools"
pnpm=$(sed -n 's/.*"packageManager": "\([^"+]*\).*/\1/p' "$repo/package.json")
docker build -q --build-arg PNPM="$pnpm" -t sb-rehearse-tool "$here" >/dev/null
# As the calling user, so what it writes in the checkout stays theirs.
tool() {
  docker run --rm --network "$net" --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$repo:/repo" -v "$dir:/work" \
    -e LOAD_DIR=/work/load -e npm_config_store_dir=/work/pnpm-store -w /repo "$@"
}
# The scripts need packages/protocol's dependencies; a checkout that has them keeps its own.
[ -d "$repo/packages/protocol/node_modules/libsodium-wrappers" ] ||
  tool -e CI=true sb-rehearse-tool pnpm install --silent --frozen-lockfile --filter @starbridge/protocol >/dev/null
tool sb-rehearse-tool bun evals/migrate/env.ts http://sb-rehearse-fake:18099 > "$dir/server.env"
for rev in "$from" "$to"; do
  docker image inspect "$image:$rev" >/dev/null 2>&1 || docker pull -q "$image:$rev" >/dev/null ||
    finish false "no server image for $rev on ghcr.io"
done
from_v=$(docker run --rm "$image:$from" bun server.js schema)
to_v=$(docker run --rm "$image:$to" bun server.js schema)

# Milliseconds since the epoch. Not %3N: uutils' date, Ubuntu 26.04's, prints every digit.
ms() { echo $(($(date +%s%N) / 1000000)); }
# Starts REV's server on DIR/starbridge.db and prints how long it took to answer /healthz, in ms;
# fails when it stopped first or took over a minute.
start() { # REV DIR
  # The image's server runs as bun, 1000.
  docker run --rm -v "$2:/d" --entrypoint chown sb-rehearse-tool -R 1000:1000 /d
  t0=$(ms)
  docker run -d --name sb-rehearse-server --network "$net" --env-file "$dir/server.env" \
    -v "$2:/data" "$image:$1" >/dev/null
  while :; do
    if docker exec sb-rehearse-server bun -e \
      "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      echo $(($(ms) - t0))
      return 0
    fi
    [ "$(docker inspect -f '{{.State.Running}}' sb-rehearse-server)" = true ] || return 1
    [ $(($(ms) - t0)) -lt 60000 ] || return 1
    sleep 0.2
  done
}
# Stops the server started on DIR and hands DIR back to the caller, whose tools read and write it next.
stop() { # DIR
  docker stop -t 30 sb-rehearse-server >/dev/null
  docker rm sb-rehearse-server >/dev/null
  docker run --rm -v "$1:/d" --entrypoint chown sb-rehearse-tool -R "$(id -u):$(id -g)" /d
}
# The database REV's server makes from nothing, and its schema.
fresh() { # REV
  rm -rf "$dir/fresh-$1"
  mkdir -p "$dir/fresh-$1"
  start "$1" "$dir/fresh-$1" >/dev/null || { docker logs --tail 20 sb-rehearse-server 2>&1; return 1; }
  stop "$dir/fresh-$1"
  tool sb-rehearse-tool bun evals/migrate/schema.ts dump "/work/fresh-$1/starbridge.db" > "$dir/fresh-$1.schema"
}

echo "[2/6] prod's schema against the migrations at $from"
fresh "$from" || finish false "the server at $from does not start on an empty database"
export_v=$(sed -n 's/^PRAGMA user_version *= *\([0-9]*\);$/\1/p' "$schema" | head -n 1)
rm -rf "$dir/export.db" "$dir/export.schema"
cp "$schema" "$dir/export.sql"
case $export_v in
  "" | *[!0-9]*) finish false "the schema export names no user_version" ;;
esac
[ "$export_v" -le "$from_v" ] ||
  finish false "the schema export is at schema $export_v, newer than prod's $from at $from_v"
if [ "$export_v" = "$from_v" ]; then
  tool sb-rehearse-tool bun evals/migrate/schema.ts load /work/export.sql /work/export.db "/work/fresh-$from/starbridge.db"
  tool sb-rehearse-tool bun evals/migrate/schema.ts dump /work/export.db > "$dir/export.schema"
  if ! d=$(diff "$dir/fresh-$from.schema" "$dir/export.schema"); then
    echo "$d"
    finish false "prod's schema differs from the migrations at $from: $d"
  fi
else
  # The export is from last night, and prod may have migrated since: seed from what $from makes.
  echo "the export is at schema ${export_v:-?}, $from at $from_v: seeding from $from's own"
  cp "$dir/fresh-$from/starbridge.db" "$dir/export.db"
fi

echo "[3/6] the candidate's schema from nothing"
fresh "$to" || finish false "the server at $to does not start on an empty database"

echo "[4/6] seed: $users users, $decisions decisions each, grown to $mb MB"
key=$( (cat "$dir/fresh-$from.schema"; echo "$users $decisions $mb") | sha256sum | cut -c1-16)
seed=$dir/seed-$key.db
if [ ! -f "$seed" ]; then
  rm -rf "$dir/seed-work" "$dir/load" "$dir"/seed-*.db
  mkdir -p "$dir/seed-work" "$dir/load"
  cp "$dir/export.db" "$dir/seed-work/starbridge.db"
  tool -d --name sb-rehearse-fake sb-rehearse-tool bun evals/load/fake.ts --host 0.0.0.0 >/dev/null
  start "$from" "$dir/seed-work" >/dev/null || finish false "the server at $from does not start on prod's schema"
  tool sb-rehearse-tool bun evals/load/setup.ts --users "$users" \
    --server http://sb-rehearse-server:8080 --fake http://sb-rehearse-fake:18099
  tool sb-rehearse-tool bun evals/migrate/fill.ts --server http://sb-rehearse-server:8080 --decisions "$decisions"
  stop "$dir/seed-work"
  docker rm -f sb-rehearse-fake >/dev/null
  tool sb-rehearse-tool bun evals/migrate/grow.ts /work/seed-work/starbridge.db --mb "$mb"
  mv "$dir/seed-work/starbridge.db" "$seed"
  rm -rf "$dir/seed-work"
fi

echo "[5/6] the candidate's server on the seed"
rm -rf "$dir/run"
mkdir -p "$dir/run"
cp "$seed" "$dir/run/starbridge.db"
if ! ms=$(start "$to" "$dir/run"); then
  logs=$(docker logs --tail 5 sb-rehearse-server 2>&1)
  finish false "the server at $to did not answer /healthz within 60 s: $logs"
fi
stop "$dir/run"
echo "answered /healthz after $ms ms"

echo "[6/6] the migrated schema against the candidate's own"
tool sb-rehearse-tool bun evals/migrate/schema.ts dump /work/run/starbridge.db > "$dir/run.schema"
if ! d=$(diff "$dir/fresh-$to.schema" "$dir/run.schema"); then
  echo "$d"
  finish false "migrating from $from_v to $to_v gives a schema other than $to's own: $d" "$ms"
fi
[ "$ms" -le $((limit * 1000)) ] ||
  finish false "the server at $to took $ms ms to answer /healthz, over the $limit s Caddy holds requests" "$ms"
finish true "schema $from_v to $to_v in $ms ms" "$ms"
