#!/bin/sh
# Run hourly by starbridge-umami-trim.timer: keeps Umami's Postgres from filling the disk
# (umami-trim.sql). A million page views is far more than the public pages see in 180 days.
set -eu
compose="docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml"
$compose exec -T umami-db psql -q -v ON_ERROR_STOP=1 -U umami -d umami \
  -v days=180 -v keep=1000000 -v replays=10000 < /opt/starbridge/deploy/host/umami-trim.sql
