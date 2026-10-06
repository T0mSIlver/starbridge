#!/bin/sh
# Writes /etc/starbridge/caddy/stats-auth (root, 0600), which the Caddyfile imports: the password
# in front of stats.starbridge.run, user tom, from the bcrypt hash in
# /etc/starbridge/secrets/stats-password-hash. Without that file it takes the hash below, of a
# random password that was thrown away: the site stays shut, and the Caddyfile still loads.
# Caddy reads the file on each load, so a new password needs a deploy but never a new container.
set -eu
f=/etc/starbridge/secrets/stats-password-hash
umask 077
mkdir -p /etc/starbridge/caddy
hash='$2a$10$uOZSG5ZxQ8OzjrdpZpTZqukonv3hVIjRfuRhAGFHE2BRSsy/x5Z0m'
# A blank file would leave basic_auth without a hash, and Caddy without a config.
[ -s "$f" ] && [ -n "$(tr -d ' \r\n\t' < "$f")" ] && hash=$(tr -d ' \r\n\t' < "$f")
tmp=$(mktemp /etc/starbridge/caddy/stats-auth.XXXXXX)
printf 'basic_auth {\n\ttom %s\n}\n' "$hash" > "$tmp"
mv "$tmp" /etc/starbridge/caddy/stats-auth
