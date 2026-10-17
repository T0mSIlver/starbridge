#!/bin/sh
# Builds /etc/<project>/server.env (root, 0600) from the files in /etc/<project>/secrets and the
# box's settings (host/apply.sh passes DEPLOY_ENV); a test passes another folder. Prod is the
# relay: FCM, APNs and Sign in with Apple. Staging holds none of prod's secrets: its own GitHub
# OAuth app and VAPID pair, and no FCM or APNs key; phones get its pushes through starbridge.run's
# relay, as from any self-hosted server (#1540), and browsers get its own Web Push. It is no relay
# itself, so nobody reaches prod's relay through it.
set -eu
cd "$(dirname "$0")/.."
. "./${DEPLOY_ENV:-host/prod.env}"
dir=${1:-/etc/$PROJECT}
s=$dir/secrets
fcm=$s/fcm-service-account.json
umask 077
tmp=$(mktemp $dir/server.env.XXXXXX)
# Single quotes keep Compose from interpolating; the server turns the key's \n back into newlines.
{
  printf '%s\n' "PUBLIC_URL='https://$SITE'"
  printf '%s\n' "TRUST_PROXY='1'"
  # The App Link the app verifies against web/public/.well-known/assetlinks.json (#527).
  [ -z "$APP_REDIRECT_URI" ] || printf '%s\n' "APP_REDIRECT_URI='$APP_REDIRECT_URI'"
  [ -z "$RELAY_MODE" ] || printf '%s\n' "RELAY_MODE='1'"
  [ -z "$RELAY_URL" ] || printf '%s\n' "RELAY_URL='$RELAY_URL'"
  # Machines per hosted account; phones and browsers don't count (#658).
  printf '%s\n' "MAX_MACHINES='3'"
  # Only the GitHub users in signup-github-ids can make an account.
  [ -z "$CLOSED_SIGNUP" ] || printf '%s\n' "SIGNUP_GITHUB_IDS='$(tr -d ' \n' < $s/signup-github-ids)'"
  if [ -n "$GITHUB_CLIENT_ID" ]; then
    printf '%s\n' "GITHUB_CLIENT_ID='$GITHUB_CLIENT_ID'"
  else
    printf '%s\n' "GITHUB_CLIENT_ID='$(tr -d '\n' < $s/github-oauth-client-id)'"
  fi
  printf '%s\n' "GITHUB_CLIENT_SECRET='$(tr -d '\n' < $s/github-oauth-client-secret)'"
  if [ -n "$RELAY_MODE" ]; then
    printf '%s\n' "FCM_PROJECT_ID='$(jq -r .project_id $fcm)'"
    printf '%s\n' "FCM_CLIENT_EMAIL='$(jq -r .client_email $fcm)'"
    printf '%s\n' "FCM_PRIVATE_KEY='$(jq -r '.private_key | gsub("\n"; "\\n")' $fcm)'"
  fi
  printf '%s\n' "VAPID_PUBLIC_KEY='$(tr -d '\n' < $s/vapid-public-key)'"
  printf '%s\n' "VAPID_PRIVATE_KEY='$(tr -d '\n' < $s/vapid-private-key)'"
  printf '%s\n' "VAPID_SUBJECT='https://$SITE'"
  # The iPhone app's APNs auth key (#1076), once the owner has made it.
  if [ -n "$RELAY_MODE" ] && [ -f $s/apns-key.p8 ]; then
    printf '%s\n' "APNS_TEAM_ID='3N63N7U9R3'"
    printf '%s\n' "APNS_TOPIC='dev.starbridge.ios'"
    printf '%s\n' "APNS_KEY_ID='$(tr -d '\n' < $s/apns-key-id)'"
    printf '%s\n' "APNS_PRIVATE_KEY='$(awk '{printf "%s\\n", $0}' $s/apns-key.p8)'"
  fi
  # The team's Sign in with Apple key (#1411), which signs the client secrets for Apple's token
  # and revoke endpoints.
  if [ -f $s/apple-signin-key.p8 ]; then
    printf '%s\n' "APPLE_TEAM_ID='3N63N7U9R3'"
    printf '%s\n' "APPLE_SERVICES_ID='dev.starbridge.web'"
    printf '%s\n' "APPLE_KEY_ID='$(tr -d '\n' < $s/apple-signin-key-id)'"
    printf '%s\n' "APPLE_PRIVATE_KEY='$(awk '{printf "%s\\n", $0}' $s/apple-signin-key.p8)'"
  fi
  # The owner sign-in, by its token (staging-app.yml's app check, #1621). Without that file the
  # server has none.
  [ ! -s $s/owner-token ] || printf '%s\n' "OWNER_TOKEN='$(tr -d ' \n' < $s/owner-token)'"
} > "$tmp"
mv "$tmp" $dir/server.env
