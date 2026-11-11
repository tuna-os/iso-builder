#!/usr/bin/env bash
# Launches the built app against Fixtures/fake-helper.sh in --ui-smoke mode
# for each scenario and collects screenshots + state dumps.
#
#   scripts/ui-smoke.sh [APP] [OUT_DIR]
#
# Scenarios: usb (pick drive → erase confirmation → write → done),
# iso (Save ISO file only → done), fail (write fails → error + details).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-$here/build/TunaOS Media Writer.app}"
out="${2:-$here/build/ui-smoke}"
fake="$here/Fixtures/fake-helper.sh"
exe="$app/Contents/MacOS/TunaOSMediaWriter"

rm -rf "$out"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
status=0
for scenario in usb iso fail; do
  dir="$out/$scenario"
  mkdir -p "$dir"
  fail_env=""
  [[ $scenario == fail ]] && fail_env=write
  echo "::group::ui-smoke $scenario"
  # The app has its own 240 s watchdog; it exits 0 only if every step's
  # expectation held.
  if FAKE_HELPER_DELAY=0.15 FAKE_HELPER_FAIL="$fail_env" \
    "$exe" --fake-helper "$fake" --ui-smoke "$dir" --ui-smoke-scenario "$scenario" \
    >"$dir/app.log" 2>&1; then
    echo "ui-smoke $scenario: passed"
  else
    echo "ui-smoke $scenario: FAILED (exit $?)"
    status=1
  fi
  cat "$dir/app.log"
  ls -l "$dir"
  echo "::endgroup::"
done
exit $status
