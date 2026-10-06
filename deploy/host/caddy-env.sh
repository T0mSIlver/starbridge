#!/bin/sh
# Builds /etc/starbridge/caddy.env (root, 0600): the bcrypt hash of the stats.starbridge.run
# password (Caddyfile), from /etc/starbridge/secrets/stats-password-hash. Without that file it
# takes the hash below, of a random password that was thrown away: the site stays shut, and the
# Caddyfile still loads.
set -eu
f=/etc/starbridge/secrets/stats-password-hash
umask 077
if [ -s "$f" ]; then
  hash=$(tr -d '\n' < "$f")
else
  hash='$2a$14$q.BhHk.2OTnx9NNOYlo6he57W7vcOnxMHR4KhD9jFBiUvGfzCNq8e'
fi
tmp=$(mktemp /etc/starbridge/caddy.env.XXXXXX)
# Single quotes keep Compose from reading the hash's $ signs as variables.
printf '%s\n' "STATS_PASSWORD_HASH='$hash'" > "$tmp"
mv "$tmp" /etc/starbridge/caddy.env
