#!/bin/bash
# Produce an unsigned device IPA for a signing installer such as Sideloadly.
# No account access, device registration, simulator runtime, or debugger launch.
set -euo pipefail
cd "$(dirname "$0")"
OUTPUT_DIR="$PWD/build/iphone-sideload"
mkdir -p "$OUTPUT_DIR"

# A target build avoids the physical-device destination checks in older Xcode.
xcodebuild -project iphone/AirPodUSBCollector.xcodeproj -target AirPodUSBCollector \
  -configuration Release -sdk iphoneos -arch arm64 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  SYMROOT="$OUTPUT_DIR/products" OBJROOT="$OUTPUT_DIR/intermediates" \
  build > "$OUTPUT_DIR/build.log" 2>&1 || {
    tail -40 "$OUTPUT_DIR/build.log"
    exit 1
  }

APP_PATH="$OUTPUT_DIR/products/Release-iphoneos/AirPodUSBCollector.app"
python3 - "$APP_PATH" <<'PY'
from pathlib import Path
import plistlib, subprocess, sys
app = Path(sys.argv[1])
info = plistlib.loads((app / 'Info.plist').read_bytes())
assert 'iPhoneOS' in info.get('CFBundleSupportedPlatforms', []), 'Not a device build'
assert info.get('NSMotionUsageDescription'), 'Missing motion permission description'
assert not (app / 'embedded.mobileprovision').exists(), 'Expected an unsigned build'
executable = app / info['CFBundleExecutable']
assert executable.is_file(), 'Missing executable'
subprocess.run(['lipo', str(executable), '-verify_arch', 'arm64'], check=True)
print('Verified arm64 iPhone app; the installer must sign it before installation.')
PY

STAGING_DIR="$(mktemp -d "$OUTPUT_DIR/package.XXXXXX")"
mkdir -p "$STAGING_DIR/Payload"
ditto "$APP_PATH" "$STAGING_DIR/Payload/AirPodUSBCollector.app"
IPA_PATH="$OUTPUT_DIR/AirPodUSBCollector.ipa"
ditto -c -k --norsrc --keepParent "$STAGING_DIR/Payload" "$STAGING_DIR/AirPodUSBCollector.ipa"
python3 - "$STAGING_DIR/AirPodUSBCollector.ipa" <<'PY'
import plistlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, 'Corrupt IPA archive'
    root = 'Payload/AirPodUSBCollector.app/'
    info = plistlib.loads(archive.read(root + 'Info.plist'))
    assert root + info['CFBundleExecutable'] in archive.namelist()
print('Verified IPA archive structure and CRCs.')
PY
mv "$STAGING_DIR/AirPodUSBCollector.ipa" "$IPA_PATH"
shasum -a 256 "$IPA_PATH" > "$OUTPUT_DIR/AirPodUSBCollector.ipa.sha256"
printf '\nUnsigned IPA ready for Sideloadly:\n%s\n' "$IPA_PATH"
