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
  # The App Link the app verifies against web/public/.well-known/assetlinks.json (#527).
  printf '%s\n' "APP_REDIRECT_URI='https://starbridge.run/app/auth'"
  printf '%s\n' "RELAY_MODE='1'"
  # Machines per hosted account; phones and browsers don't count (#658).
  printf '%s\n' "MAX_MACHINES='3'"
  printf '%s\n' "GITHUB_CLIENT_ID='Ov23liEVyfnca8hO548x'"
  printf '%s\n' "GITHUB_CLIENT_SECRET='$(tr -d '\n' < $s/github-oauth-client-secret)'"
  printf '%s\n' "FCM_PROJECT_ID='$(jq -r .project_id $fcm)'"
  printf '%s\n' "FCM_CLIENT_EMAIL='$(jq -r .client_email $fcm)'"
  printf '%s\n' "FCM_PRIVATE_KEY='$(jq -r '.private_key | gsub("\n"; "\\n")' $fcm)'"
  printf '%s\n' "VAPID_PUBLIC_KEY='$(tr -d '\n' < $s/vapid-public-key)'"
  printf '%s\n' "VAPID_PRIVATE_KEY='$(tr -d '\n' < $s/vapid-private-key)'"
  printf '%s\n' "VAPID_SUBJECT='https://starbridge.run'"
  # The iPhone app's APNs auth key (#1076), once the owner has made it.
  if [ -f $s/apns-key.p8 ]; then
    printf '%s\n' "APNS_TEAM_ID='3N63N7U9R3'"
    printf '%s\n' "APNS_TOPIC='dev.starbridge.ios'"
    printf '%s\n' "APNS_KEY_ID='$(tr -d '\n' < $s/apns-key-id)'"
    printf '%s\n' "APNS_PRIVATE_KEY='$(awk '{printf "%s\\n", $0}' $s/apns-key.p8)'"
  fi
  # The team's Sign in with Apple key (#1411), which signs the client secrets for Apple's token
  # and revoke endpoints.
  if [ -f $s/apple-signin-key.p8 ]; then
    printf '%s\n' "APPLE_TEAM_ID='3N63N7U9R3'"
    printf '%s\n' "APPLE_KEY_ID='$(tr -d '\n' < $s/apple-signin-key-id)'"
    printf '%s\n' "APPLE_PRIVATE_KEY='$(awk '{printf "%s\\n", $0}' $s/apple-signin-key.p8)'"
  fi
} > "$tmp"
mv "$tmp" /etc/starbridge/server.env
