#!/bin/sh
# Sends the newest nightly copy off the box, after backup.sh (#1482): compressed, encrypted to the
# owner's age key, whose private half is on neither server, and pushed to a host that takes new
# files only (rrsync -wo -no-del -no-overwrite), which keeps 14 days. Without the offsite secrets
# (push-secrets.sh), as on a self-hosted box, it does nothing.
set -eu
s=/etc/starbridge/secrets
[ -f "$s/offsite-target" ] || { echo "offsite.sh: no offsite-target, skipped"; exit 0; }
src=$(ls /var/backups/starbridge/starbridge-*.db | sort | tail -n 1)
name=$(basename "$src").zst.age
tmp=$(mktemp -d /var/backups/starbridge/offsite.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
# At the lowest priority, so the server's requests come first on the two cores.
nice -n 19 ionice -c 3 sh -c "zstd -q -T1 -c '$src' | age -R '$s/backup-age.pub' -o '$tmp/$name'"
nice -n 19 rsync --chmod=F600 -e "ssh -i $s/offsite-ssh-key -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$s/offsite-known-hosts" \
  "$tmp/$name" "$(cat "$s/offsite-target"):$name"
