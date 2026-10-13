#!/bin/sh
# Builds /etc/starbridge-staging/server.env (root, 0600) from the files in
# /etc/starbridge-staging/secrets, which push-secrets.sh copies. Staging holds none of prod's:
# its own GitHub OAuth app ("Starbridge staging") and VAPID pair, and no FCM or APNs key: phones
# get its pushes through starbridge.run's relay, as from any self-hosted server (#1540), and
# browsers get its own Web Push. It is no relay itself, so nobody reaches prod's relay through it.
# Only the GitHub users in signup-github-ids can make an account.
set -eu
s=/etc/starbridge-staging/secrets
umask 077
tmp=$(mktemp /etc/starbridge-staging/server.env.XXXXXX)
{
  printf '%s\n' "PUBLIC_URL='https://staging.starbridge.run'"
  printf '%s\n' "TRUST_PROXY='1'"
  printf '%s\n' "RELAY_URL='https://starbridge.run'"
  printf '%s\n' "MAX_MACHINES='3'"
  printf '%s\n' "SIGNUP_GITHUB_IDS='$(tr -d ' \n' < $s/signup-github-ids)'"
  printf '%s\n' "GITHUB_CLIENT_ID='$(tr -d '\n' < $s/github-oauth-client-id)'"
  printf '%s\n' "GITHUB_CLIENT_SECRET='$(tr -d '\n' < $s/github-oauth-client-secret)'"
  printf '%s\n' "VAPID_PUBLIC_KEY='$(tr -d '\n' < $s/vapid-public-key)'"
  printf '%s\n' "VAPID_PRIVATE_KEY='$(tr -d '\n' < $s/vapid-private-key)'"
  printf '%s\n' "VAPID_SUBJECT='https://staging.starbridge.run'"
} > "$tmp"
mv "$tmp" /etc/starbridge-staging/server.env
