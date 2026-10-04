#!/bin/sh
# Copies the live SQLite file with `.backup` and keeps 14 days of copies.
set -eu
dir=/var/backups/starbridge
db=$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)/starbridge.db
out=$dir/starbridge-$(date -u +%Y%m%d).db
uid=$(stat -c %u "$db")
gid=$(stat -c %g "$db")
# sqlite3 runs as the file's owner: a WAL file or index it creates must stay writable by the
# server. It writes into a staging directory that owner can reach.
stage=$dir/stage
install -d -m 700 -o "$uid" -g "$gid" "$stage"
rm -f "$stage/copy.db"
setpriv --reuid="$uid" --regid="$gid" --clear-groups \
  sqlite3 "$db" ".backup '$stage/copy.db'"
sqlite3 "$stage/copy.db" 'PRAGMA integrity_check' | grep -qx ok
chown root:root "$stage/copy.db"
chmod 600 "$stage/copy.db"
mv "$stage/copy.db" "$out"
find "$dir" -maxdepth 1 -name 'starbridge-*.db' -mtime +13 -delete
