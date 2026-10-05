#!/bin/sh
# Makes /etc/starbridge/umami.env and umami-db.env (root, 0600) on the first deploy and leaves
# them alone after: Postgres keeps the password it was first started with.
set -eu
[ -e /etc/starbridge/umami.env ] && exit 0
umask 077
pw=$(openssl rand -hex 32)
printf '%s\n' "POSTGRES_PASSWORD='$pw'" > /etc/starbridge/umami-db.env
{
  printf '%s\n' "DATABASE_URL='postgresql://umami:$pw@umami-db:5432/umami'"
  printf '%s\n' "APP_SECRET='$(openssl rand -hex 32)'"
} > /etc/starbridge/umami.env.tmp
mv /etc/starbridge/umami.env.tmp /etc/starbridge/umami.env
