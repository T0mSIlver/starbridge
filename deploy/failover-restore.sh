#!/bin/sh
# From the operator's machine: puts the newest offsite copy of prod's database (sb-oracle, #1482)
# into the starbridge_data volume of another host, the first step of a failover or its drill
# (deploy/README.md, "Failover"). It decrypts the copy here, with the key only this machine
# holds, checks it, and shreds the plain copy when done. A database already on the host is moved
# aside, never overwritten.
#   deploy/failover-restore.sh [HOST]     an SSH host with sudo; default sb-staging (sb-staging)
set -eu
host=${1:-sb-staging}
age_key=$HOME/.config/starbridge/secrets/backup-age.key
tmp=$(mktemp -d)
trap 'shred -u "$tmp"/* 2>/dev/null; rm -rf "$tmp"' EXIT
# A signal ends through the EXIT trap, so the plain copy never stays behind.
trap 'exit 1' INT TERM HUP
newest=$(ssh sb-oracle 'sudo ls -1 /srv/offsite/starbridge' | grep -E '^starbridge-[0-9]{8}\.db\.zst\.age$' | sort | tail -n 1)
[ -n "$newest" ] || { echo "no offsite copy on sb-oracle" >&2; exit 1; }
echo "restoring $newest"
ssh sb-oracle "sudo cat /srv/offsite/starbridge/$newest" > "$tmp/db.age"
age -d -i "$age_key" "$tmp/db.age" | zstd -dq -o "$tmp/starbridge.db"
sqlite3 -readonly "$tmp/starbridge.db" 'PRAGMA integrity_check' | grep -qx ok
echo "schema $(sqlite3 -readonly "$tmp/starbridge.db" 'PRAGMA user_version'), $(sqlite3 -readonly "$tmp/starbridge.db" 'SELECT count(*) FROM accounts') accounts"
# Under the deploy lock, with any container on the volume stopped while its database is swapped
# (a failback onto a server that still runs), then started again. The server runs as bun (1000)
# and writes its WAL beside the database, so the volume's directory is bun's too.
ssh "$host" 'sudo sh -euc "
  exec 9>/run/starbridge-deploy.lock
  flock 9
  docker volume create starbridge_data >/dev/null
  mnt=\$(docker volume inspect -f {{.Mountpoint}} starbridge_data)
  # The copy lands first, so a full disk fails here with the server still up.
  umask 077
  cat > \$mnt/starbridge.db.part
  chown 1000:1000 \$mnt \$mnt/starbridge.db.part
  running=\$(docker ps -q --filter volume=starbridge_data)
  [ -z \"\$running\" ] || docker stop \$running >/dev/null
  # Renames only, from here to the start: nothing in between needs room.
  for f in starbridge.db starbridge.db-wal starbridge.db-shm; do
    [ ! -e \$mnt/\$f ] || mv \$mnt/\$f \$mnt/\$f.before-restore-\$(date -u +%Y%m%dT%H%M%S)
  done
  mv \$mnt/starbridge.db.part \$mnt/starbridge.db
  [ -z \"\$running\" ] || docker start \$running >/dev/null
"' < "$tmp/starbridge.db"
echo "restored into $host's starbridge_data volume"
