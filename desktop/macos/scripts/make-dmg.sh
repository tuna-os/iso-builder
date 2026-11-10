#!/usr/bin/env bash
# Packs the app into a compressed drag-to-Applications disk image.
#
#   SIGN_IDENTITY=- scripts/make-dmg.sh [APP] [DMG]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$here/build/TunaOS Media Writer.app}"
dmg="${2:-$here/build/TunaOS-Media-Writer-macOS.dmg}"
identity="${SIGN_IDENTITY:--}"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"

rm -f "$dmg"
# hdiutil occasionally fails with "Resource busy" on CI runners; retry.
for attempt in 1 2 3; do
  if hdiutil create -volname "TunaOS Media Writer" -srcfolder "$staging" -ov -format UDZO "$dmg"; then
    break
  fi
  [[ $attempt == 3 ]] && exit 1
  sleep 5
done

if [[ "$identity" != "-" ]]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
fi
hdiutil verify "$dmg"
echo "built $dmg"
