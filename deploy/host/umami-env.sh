#!/bin/sh
# Makes /etc/starbridge/umami.env and umami-db.env (root, 0600) on the first deploy and leaves
# them alone after: Postgres keeps the password it was first started with. With one of the two
# missing (a partial restore, a deleted file), a new password would not open the existing
# database, so it stops rather than make one (#1300).
set -eu
cd /etc/starbridge
if [ -e umami.env ] || [ -e umami-db.env ]; then
  [ -e umami.env ] && [ -e umami-db.env ] && exit 0
  echo "umami-env.sh: only one of /etc/starbridge/umami.env and umami-db.env exists. Restore the other, both from the same password; or, to start Umami empty, delete it and the umami-db volume." >&2
  exit 1
fi
umask 077
pw=$(openssl rand -hex 32)
printf '%s\n' "POSTGRES_PASSWORD='$pw'" > umami-db.env.tmp
{
  printf '%s\n' "DATABASE_URL='postgresql://umami:$pw@umami-db:5432/umami'"
  printf '%s\n' "APP_SECRET='$(openssl rand -hex 32)'"
} > umami.env.tmp
mv umami-db.env.tmp umami-db.env
mv umami.env.tmp umami.env
