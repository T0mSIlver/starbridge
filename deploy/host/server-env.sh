#!/bin/sh
# Builds /etc/starbridge/server.env (root, 0600) from the files in /etc/starbridge/secrets.
set -eu
s=/etc/starbridge/secrets
fcm=$s/fcm-service-account.json
umask 077
tmp=$(mktemp /etc/starbridge/server.env.XXXXXX)
# Single quotes keep Compose from interpolating; the server turns the key's \n back into newlines.
{
  printf '%s\n' "PUBLIC_URL='https://starbridge.run'"
  printf '%s\n' "TRUST_PROXY='1'"
  printf '%s\n' "RELAY_MODE='1'"
  printf '%s\n' "GITHUB_CLIENT_ID='Ov23liEVyfnca8hO548x'"
  printf '%s\n' "GITHUB_CLIENT_SECRET='$(tr -d '\n' < $s/github-oauth-client-secret)'"
  printf '%s\n' "FCM_PROJECT_ID='$(jq -r .project_id $fcm)'"
  printf '%s\n' "FCM_CLIENT_EMAIL='$(jq -r .client_email $fcm)'"
  printf '%s\n' "FCM_PRIVATE_KEY='$(jq -r '.private_key | gsub("\n"; "\\n")' $fcm)'"
  printf '%s\n' "VAPID_PUBLIC_KEY='$(tr -d '\n' < $s/vapid-public-key)'"
  printf '%s\n' "VAPID_PRIVATE_KEY='$(tr -d '\n' < $s/vapid-private-key)'"
  printf '%s\n' "VAPID_SUBJECT='https://starbridge.run'"
} > "$tmp"
mv "$tmp" /etc/starbridge/server.env
