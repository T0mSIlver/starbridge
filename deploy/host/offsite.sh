#!/bin/sh
# Sends the newest nightly copy off the box, after backup.sh (#1482): compressed, encrypted to the
# owner's age key, whose private half is on neither server, and pushed to a host that takes new
# files only (rrsync -wo -no-del -no-overwrite), which keeps 14 days. Without the offsite secrets
# (push-secrets.sh), as on a self-hosted box, it does nothing. A copy that fails to arrive shows on
# the receiving host, which alerts when its newest copy is over 26 hours old.
set -eu
s=/etc/starbridge/secrets
[ -f "$s/offsite-target" ] || { echo "offsite.sh: no offsite-target, skipped"; exit 0; }
src=$(ls /var/backups/starbridge/starbridge-*.db | sort | tail -n 1)
name=$(basename "$src").zst.age
# A run killed before its trap (a reboot) leaves an unencrypted copy behind: remove any older than
# the unit's 6-hour limit, so none outlives the backups /privacy counts.
find /var/backups/starbridge -maxdepth 1 -type d -name 'offsite.*' -mmin +360 -exec rm -rf {} +
tmp=$(mktemp -d /var/backups/starbridge/offsite.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM HUP
# At the lowest priority, so the server's requests come first on the two cores. Two steps, not a
# pipe: a zstd that died halfway would leave age encrypting a truncated copy, which the receiver
# then never lets us replace.
nice -n 19 ionice -c 3 zstd -q -T1 "$src" -o "$tmp/db.zst"
nice -n 19 ionice -c 3 age -R "$s/backup-age.pub" -o "$tmp/$name" "$tmp/db.zst"
nice -n 19 rsync --chmod=F600 -e "ssh -i $s/offsite-ssh-key -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$s/offsite-known-hosts" \
  "$tmp/$name" "$(cat "$s/offsite-target"):$name"
