#!/bin/sh
# Copies the live SQLite file with `.backup`, dumps Umami's Postgres, and keeps 7 days of both:
# 10 copies of the database (live, 7 nightly, 2 per deploy) must fit the disk (#586).
set -eu
dir=/var/backups/starbridge
db=$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)/starbridge.db
out=$dir/starbridge-$(date -u +%Y%m%d).db
umask 077
# VACUUM INTO reads one snapshot while the server writes, and leaves free pages out (#586). It
# refuses a file that exists, such as an interrupted run's.
rm -f "$out.tmp"
sqlite3 "$db" "VACUUM INTO '$out.tmp'"
# sqlite3 runs as root: hand back any WAL or shared-memory file it created, or the server
# could no longer write the database.
chown --reference="$db" "$db"-wal "$db"-shm 2>/dev/null || true
sqlite3 "$out.tmp" 'PRAGMA integrity_check' | grep -qx ok
mv "$out.tmp" "$out"
# Umami's analytics, in pg_dump's compressed format; pg_restore -l checks it reads back.
umami=$dir/umami-$(date -u +%Y%m%d).dump
compose="docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml"
$compose exec -T umami-db pg_dump -U umami -Fc umami > "$umami.tmp"
$compose exec -T umami-db pg_restore -l < "$umami.tmp" >/dev/null
mv "$umami.tmp" "$umami"
# The server answers /healthz/backup from this file's age.
touch "$(dirname "$db")/last-backup"
find "$dir" -maxdepth 1 \( \( -name 'starbridge-*.db' -o -name 'umami-*.dump' \) -mtime +6 -o -name '*.tmp' -mtime +0 \) -delete
