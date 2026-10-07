#!/bin/sh
# Writes /etc/starbridge/caddy/stats-auth (root, 0600), which the Caddyfile imports: the password
# in front of stats.starbridge.run (its stats_gate snippet), user tom, from the bcrypt hash in
# /etc/starbridge/secrets/stats-password-hash, and the cookie that stands for it on the API, a
# hash of that hash, so a new password also ends the old cookie. Without that file it takes the hash below, of a
# random password that was thrown away, and a random cookie, since one derived from a hash in the
# repository would open the API to anyone (#717): the site stays shut, and the Caddyfile still loads.
# Caddy reads the file on each load, so a new password needs a deploy but never a new container.
set -eu
f=/etc/starbridge/secrets/stats-password-hash
umask 077
mkdir -p /etc/starbridge/caddy
hash='$2a$10$uOZSG5ZxQ8OzjrdpZpTZqukonv3hVIjRfuRhAGFHE2BRSsy/x5Z0m'
key=$(head -c 32 /dev/urandom | sha256sum | cut -c1-64)
# A blank file would leave basic_auth without a hash, and Caddy without a config.
if [ -s "$f" ] && [ -n "$(tr -d ' \r\n\t' < "$f")" ]; then
  hash=$(tr -d ' \r\n\t' < "$f")
  key=$(printf '%s' "$hash" | sha256sum | cut -c1-64)
fi
tmp=$(mktemp /etc/starbridge/caddy/stats-auth.XXXXXX)
printf 'import stats_gate %s %s\n' "$hash" "$key" > "$tmp"
mv "$tmp" /etc/starbridge/caddy/stats-auth
