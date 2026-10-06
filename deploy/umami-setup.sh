#!/bin/sh
# Run once from the operator's machine after the first deploy with Umami. Through an SSH tunnel to its
# dashboard, it replaces Umami's default admin password with a random one, kept in
# ~/.config/starbridge/secrets/umami-admin-password, and adds the website whose id the public
# pages send (WEBSITE_ID in web/src/lib/analytics.ts), the launch funnel (#559) and a share link
# for it, served on stats.starbridge.run (deploy/Caddyfile). Safe to run again.
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

auth() {
  path=$1
  shift
  curl -fsS "$url/api/websites/$id/$path" -H "authorization: Bearer $token" "$@"
}
# The steps the pages send (web/src/components/Landing.tsx, web/src/lib/funnel.ts), made or brought
# up to date. The window is a day: Umami's daily salt splits a visit at midnight UTC anyway.
funnel=$(jq -n '{name: "Launch",
  description: "Landing view, sign-in click, first sign-in, recovery key, first machine, first answer",
  parameters: {window: 1440, steps: [
    {type: "path", value: "/"},
    {type: "event", value: "sign-in"},
    {type: "event", value: "first-sign-in"},
    {type: "event", value: "first-keys"},
    {type: "event", value: "first-machine"},
    {type: "event", value: "first-answer"}]}}')
funnels=$(auth funnels)
fid=$(echo "$funnels" | jq -r '[.data[] | select(.name == "Launch")][0].id // empty')
auth "funnels${fid:+/$fid}" -H 'content-type: application/json' -d "$funnel" >/dev/null
if [ -n "$fid" ]; then echo "funnel Launch updated"; else echo "funnel Launch added"; fi

# Read-only views for the owner's phone; the link holds the only secret.
views='{overview: true, events: true, funnels: true, journeys: true}'
shares=$(auth shares)
share=$(echo "$shares" | jq -c '[.data[] | select(.name == "Owner")][0] // empty')
if [ -z "$share" ]; then
  share=$(auth shares -H 'content-type: application/json' \
    -d "$(jq -n "{name: \"Owner\", parameters: $views}")")
else
  share=$(curl -fsS "$url/api/share/id/$(echo "$share" | jq -r .id)" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "$(echo "$share" | jq "{name, slug, parameters: $views}")")
fi
slug=$(echo "$share" | jq -r '.slug // empty')
[ -n "$slug" ] || { echo "Umami made no share link: $share" >&2; exit 1; }
echo "share link: https://stats.starbridge.run/share/$slug"
