#!/bin/bash
# Checks the widget in a packaged app (#1031): the extension and its helper are signed inside the
# app's seal, the extension sandboxed, both in the App Group. Usage: check-widgets.sh <Starbridge.app>
set -euo pipefail
app=$1
appex="$app/Contents/PlugIns/StarbridgeWidgets.appex"
helper="$app/Contents/MacOS/starbridge-widgets"
group=$(sed -n 's/^export const APP_GROUP = "\(.*\)";$/\1/p' "$(dirname "$0")/../src/widgets.ts")
codesign --verify --deep --strict "$app"
for f in "$appex" "$helper"; do
  codesign --verify --strict "$f"
  codesign -d --entitlements - --xml "$f" 2>/dev/null | grep -q "<string>$group</string>" || { echo "$f: not in $group" >&2; exit 1; }
done
codesign -d --entitlements - --xml "$appex" 2>/dev/null | grep -q "com.apple.security.app-sandbox" || { echo "$appex: not sandboxed" >&2; exit 1; }
plutil -extract NSExtension.NSExtensionPointIdentifier raw "$appex/Contents/Info.plist" | grep -qx com.apple.widgetkit-extension
lipo "$appex/Contents/MacOS/StarbridgeWidgets" -verify_arch arm64 x86_64
echo "widget ok: $appex"
