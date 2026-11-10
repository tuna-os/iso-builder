#!/usr/bin/env bash
# Assembles "TunaOS Media Writer.app" (universal arm64 + x86_64) and signs it.
#
#   VERSION=1.2.3 BUILD_NUMBER=45 SIGN_IDENTITY=- scripts/build-app.sh
#
# Inputs (environment):
#   HELPER_DIR     universal tunaos-media-helper + tunaos-media-engine
#                  (default build/helper, see scripts/build-helper.sh)
#   VERSION        CFBundleShortVersionString (default 0.0.0)
#   BUILD_NUMBER   CFBundleVersion (default 0)
#   SIGN_IDENTITY  "-" = ad-hoc (default); otherwise a "Developer ID
#                  Application: …" identity in the keychain, signed with the
#                  hardened runtime and a secure timestamp for notarization.
#   OUT            output directory (default build)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
out="${OUT:-$here/build}"
helper_dir="${HELPER_DIR:-$out/helper}"
version="${VERSION:-0.0.0}"
build_number="${BUILD_NUMBER:-0}"
identity="${SIGN_IDENTITY:--}"
app="$out/TunaOS Media Writer.app"

for bin in tunaos-media-helper tunaos-media-engine; do
  [[ -x "$helper_dir/$bin" ]] || { echo "missing $helper_dir/$bin (run scripts/build-helper.sh)" >&2; exit 1; }
done

swift_flags=(-c release --arch arm64 --arch x86_64 --product TunaOSMediaWriter)
swift build "${swift_flags[@]}"
bin_dir="$(swift build "${swift_flags[@]}" --show-bin-path)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/TunaOSMediaWriter" "$app/Contents/MacOS/TunaOSMediaWriter"
# Bundle.main.url(forAuxiliaryExecutable:) looks in Contents/MacOS; the
# helper finds the engine next to itself.
cp "$helper_dir/tunaos-media-helper" "$helper_dir/tunaos-media-engine" "$app/Contents/MacOS/"

cp Resources/Info.plist "$app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$build_number" "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist"

# Icon from the website's fish mark.
iconset="$out/AppIcon.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
mark="$here/../../app/public/mark-192.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$mark" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$mark" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$iconset"

# Inner executables first, then the bundle (no --deep: it is deprecated and
# hides which binary failed).
if [[ "$identity" == "-" ]]; then
  sign=(codesign --force --sign -)
else
  sign=(codesign --force --options runtime --timestamp --sign "$identity")
fi
"${sign[@]}" "$app/Contents/MacOS/tunaos-media-engine"
"${sign[@]}" "$app/Contents/MacOS/tunaos-media-helper"
"${sign[@]}" --identifier org.tunaos.MediaWriter "$app"
codesign --verify --strict --verbose=2 "$app"

for bin in TunaOSMediaWriter tunaos-media-helper tunaos-media-engine; do
  lipo -info "$app/Contents/MacOS/$bin"
done
echo "built $app"
