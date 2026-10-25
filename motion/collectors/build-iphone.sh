#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# Compile validation only. Install/sign on the physical phone using Xcode.
xcodebuild -project iphone/AirPodUSBCollector.xcodeproj -scheme AirPodUSBCollector \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$PWD/build/iphone" CODE_SIGNING_ALLOWED=NO build
