#!/bin/sh
# Run once from the dev box after the first deploy with Umami. Through an SSH tunnel to its
# dashboard, it replaces Umami's default admin password with a random one, kept in
# ~/.config/starbridge/secrets/umami-admin-password, and adds the website whose id the public
# pages send (WEBSITE_ID in web/src/lib/analytics.ts). Safe to run again.
set -eu
host=${STARBRIDGE_HOST:-deploy@starbridge.run}
key=$HOME/.ssh/starbridge_ed25519
port=${UMAMI_PORT:-3001}
pwfile=$HOME/.config/starbridge/secrets/umami-admin-password
cd "$(git rev-parse --show-toplevel)"
id=$(sed -n 's/^export const WEBSITE_ID = "\(.*\)";$/\1/p' web/src/lib/analytics.ts)
[ -n "$id" ] || { echo "no WEBSITE_ID in web/src/lib/analytics.ts" >&2; exit 1; }

if [ -z "${UMAMI_URL:-}" ]; then
  sock=$(mktemp -u)
  ssh -i "$key" -M -S "$sock" -fN -o ExitOnForwardFailure=yes -L "$port:127.0.0.1:3001" "$host"
  trap 'ssh -S "$sock" -O exit "$host" 2>/dev/null' EXIT
fi
url=${UMAMI_URL:-http://127.0.0.1:$port}

login() {
  curl -fsS "$url/api/auth/login" -H 'content-type: application/json' \
    -d "$(jq -n --arg p "$1" '{username: "admin", password: $p}')" | jq -r .token
}
if [ ! -s "$pwfile" ]; then
  token=$(login umami)
  umask 077
  openssl rand -base64 24 > "$pwfile.tmp"
  curl -fsS "$url/api/me/password" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg p "$(cat "$pwfile.tmp")" '{currentPassword: "umami", newPassword: $p}')" \
    >/dev/null
  mv "$pwfile.tmp" "$pwfile"
  echo "admin password changed; it is in $pwfile"
fi
# Changing the password ends the session it was changed in.
token=$(login "$(cat "$pwfile")")

# Umami answers an unknown website with null.
if [ "$(curl -fsS "$url/api/websites/$id" -H "authorization: Bearer $token" | jq -r .id)" = "$id" ]; then
  echo "website $id already there"
else
  curl -fsS "$url/api/websites" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg id "$id" '{id: $id, name: "starbridge.run", domain: "starbridge.run"}')" \
    >/dev/null
  echo "website $id added"
fi
