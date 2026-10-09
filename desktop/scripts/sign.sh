#!/bin/bash
# Builds the macOS app signed with the Developer ID and notarized, on a Mac, from the secrets the
# workflows pass in (desktop/README.md, "Signing"): MAC_CERTIFICATE (a base64 .p12) and
# MAC_CERTIFICATE_PASSWORD, and an App Store Connect API key, APPLE_API_KEY (base64 .p8),
# APPLE_API_KEY_ID and APPLE_API_ISSUER. Run from desktop/ after `pnpm run build`.
set -euo pipefail
for v in MAC_CERTIFICATE MAC_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  [ -n "${!v:-}" ] || { echo "missing secret $v" >&2; exit 1; }
done
key="$(mktemp -d)/AuthKey.p8"
trap 'rm -f "$key"' EXIT
(umask 077; printf '%s' "$APPLE_API_KEY" | base64 --decode > "$key")
CSC_LINK="$MAC_CERTIFICATE" CSC_KEY_PASSWORD="$MAC_CERTIFICATE_PASSWORD" CSC_FOR_PULL_REQUEST=false \
  APPLE_API_KEY="$key" \
  pnpm exec electron-builder --mac --publish never -c.mac.notarize=true -c.forceCodeSigning=true
# A missing or expired identity must fail here, not ship an app installed copies refuse.
for app in release/mac*/Starbridge.app; do
  codesign --verify --deep --strict "$app"
  spctl --assess --type execute --verbose=2 "$app" 2>&1 | tee /dev/stderr | grep -q "source=Notarized Developer ID"
done
