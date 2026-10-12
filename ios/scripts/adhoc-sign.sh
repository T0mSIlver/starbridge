#!/bin/sh
# Signs an archive built with CODE_SIGNING_ALLOWED=NO ad hoc, with each target's entitlements, so
# that `xcodebuild -exportArchive` finds them when it signs for the App Store (#1415): building
# for a device with signing on would need an Xcode account or a development profile.
# Usage, from ios/ after `xcodegen generate`: scripts/adhoc-sign.sh <archive>
set -eu
team=3N63N7U9R3
app="$1/Products/Applications/Starbridge.app"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Xcode adds the app identifier and team to what the project asks for.
sign() { # <bundle> <entitlements> <bundle id>
  cp "$2" "$tmp/e.plist"
  /usr/libexec/PlistBuddy -c "Add :application-identifier string $team.$3" \
    -c "Add :com.apple.developer.team-identifier string $team" "$tmp/e.plist"
  codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$tmp/e.plist" "$1"
}
# Inside out: the extension, then the app that holds it.
sign "$app/PlugIns/StarbridgeNotifications.appex" Notifications/StarbridgeNotifications.entitlements dev.starbridge.ios.notifications
sign "$app" Starbridge/Starbridge.entitlements dev.starbridge.ios
codesign --verify --deep --strict "$app"
