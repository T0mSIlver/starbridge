#!/bin/bash
# Builds the widget extension and its helper for arm64 and x86_64, unsigned, into widgets/build:
# StarbridgeWidgets.appex and starbridge-widgets. scripts/after-pack.cjs puts them in the app and
# signs them. Needs Xcode's macOS SDK.
# Usage: build.sh <app bundle id> <short version> <bundle version> <App Group>, from the app's Info.plist.
set -euo pipefail
cd "$(dirname "$0")"
id=$1 short=$2 version=$3 group=$4
out=build
rm -rf "$out" && mkdir -p "$out/obj"
sdk=$(xcrun --sdk macosx --show-sdk-path)
for arch in arm64 x86_64; do
  # An extension starts in NSExtensionMain, which finds the @main WidgetBundle.
  xcrun swiftc -sdk "$sdk" -target "$arch-apple-macos14.0" -O -parse-as-library -application-extension \
    -Xlinker -e -Xlinker _NSExtensionMain -o "$out/obj/widgets-$arch" NeedsYou.swift
  xcrun swiftc -sdk "$sdk" -target "$arch-apple-macos14.0" -O -o "$out/obj/helper-$arch" reload.swift
done
appex="$out/StarbridgeWidgets.appex/Contents"
mkdir -p "$appex/MacOS" "$appex/Resources"
lipo -create "$out"/obj/widgets-* -output "$appex/MacOS/StarbridgeWidgets"
lipo -create "$out"/obj/helper-* -output "$out/starbridge-widgets"
sed -e "s/BUNDLE_ID/$id.widgets/" -e "s/SHORT_VERSION/$short/" -e "s/BUNDLE_VERSION/$version/" -e "s/APP_GROUP/$group/" Info.plist > "$appex/Info.plist"
plutil -lint "$appex/Info.plist" >/dev/null
cp ../../android/app/src/main/res/font/google_sans_flex.ttf "$appex/Resources/GoogleSansFlex.ttf"
rm -rf "$out/obj"
