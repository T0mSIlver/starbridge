#!/bin/sh
# Copies the live SQLite file with `.backup` and keeps 14 days of copies.
set -eu
dir=/var/backups/starbridge
db=$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)/starbridge.db
out=$dir/starbridge-$(date -u +%Y%m%d).db
umask 077
sqlite3 "$db" ".backup '$out.tmp'"
# sqlite3 runs as root: hand back any WAL or shared-memory file it created, or the server
# could no longer write the database.
chown --reference="$db" "$db"-wal "$db"-shm 2>/dev/null || true
sqlite3 "$out.tmp" 'PRAGMA integrity_check' | grep -qx ok
mv "$out.tmp" "$out"
# The server answers /healthz/backup from this file's age.
touch "$(dirname "$db")/last-backup"
find "$dir" -maxdepth 1 \( -name 'starbridge-*.db' -mtime +13 -o -name '*.tmp' -mtime +0 \) -delete
