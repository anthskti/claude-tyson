#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP="$PWD/build/AirPodsCollector.app"
mkdir -p "$APP/Contents/MacOS" "$PWD/build/module-cache"
cp swift/Info.plist "$APP/Contents/Info.plist"
xcrun swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx14.0" \
  -module-cache-path "$PWD/build/module-cache" \
  -framework AppKit -framework CoreMotion swift/Collector.swift \
  -o "$APP/Contents/MacOS/AirPodsCollector"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
printf '\nBuilt %s\nLaunch with: open "%s"\n' "$APP" "$APP"
