#!/bin/sh
# Fake tunaos-media-helper speaking protocol 1 (desktop/PROTOCOL.md), for the
# macOS app's unit tests and the CI UI smoke (`--fake-helper`). It never
# touches a disk: `build` writes a few bytes to --out, `write` only reports
# progress.
#
# Knobs (environment):
#   FAKE_HELPER_DELAY=0.01      seconds between progress events
#   FAKE_HELPER_FAIL=build|write|catalog|drives   fail that subcommand
#   FAKE_HELPER_DRIVES=none     report no drives
#   FAKE_HELPER_PROTOCOL=1      protocol number reported by `version`
#   FAKE_HELPER_ARGS_LOG=PATH   append "<subcommand> <args…>" per invocation
set -u

cmd="${1:-}"
[ $# -gt 0 ] && shift
[ -n "${FAKE_HELPER_ARGS_LOG:-}" ] && echo "$cmd $*" >>"$FAKE_HELPER_ARGS_LOG"

events="" cancel="" out="" iso="" device="" target="" request=""
while [ $# -gt 0 ]; do
  case "$1" in
    --events) events="$2"; shift 2 ;;
    --cancel-file) cancel="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --iso) iso="$2"; shift 2 ;;
    --device) device="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --request) request="$2"; shift 2 ;;
    --exclude | --base-url | --workdir | --flatpaks | --fd) shift 2 ;;
    --no-verify) shift ;;
    *)
      echo "fake-helper: unknown argument $1" >&2
      printf '%s\n' '{"event":"error","kind":"usage","message":"Unknown argument."}'
      exit 2
      ;;
  esac
done

delay="${FAKE_HELPER_DELAY:-0.01}"
fail="${FAKE_HELPER_FAIL:-}"

emit() {
  if [ -n "$events" ]; then printf '%s\n' "$1" >>"$events"; else printf '%s\n' "$1"; fi
}

cancelled() {
  echo "fake-helper: cancelled" >&2
  emit '{"event":"error","kind":"cancelled","message":"Cancelled."}'
  exit 130
}
trap cancelled TERM INT

check_cancel() {
  if [ -n "$cancel" ] && [ -f "$cancel" ]; then cancelled; fi
}

# phase NAME STEPS UNIT TOTAL
phase() {
  i=0
  while [ "$i" -le "$2" ]; do
    check_cancel
    emit "{\"event\":\"progress\",\"phase\":\"$1\",\"current\":$(($4 * i / $2)),\"total\":$4,\"unit\":\"$3\",\"message\":\"$1 $i/$2\"}"
    i=$((i + 1))
    sleep "$delay"
  done
}

case "$cmd" in
  version)
    emit "{\"event\":\"version\",\"helper\":\"0.0.0-fake\",\"engine\":\"fake\",\"protocol\":${FAKE_HELPER_PROTOCOL:-1}}"
    ;;
  catalog)
    if [ "$fail" = catalog ]; then
      emit '{"event":"error","kind":"network","message":"Could not reach iso.tunaos.org."}'
      exit 1
    fi
    emit '{"event":"log","level":"info","message":"fake catalog"}'
    emit '{"event":"catalog","snapshotDigest":"sha256:fake","defaultTarget":"yellowfin:gnome:linux/amd64","desktops":[{"id":"gnome","label":"GNOME","description":"A clean, focused desktop with big, simple controls."},{"id":"kde","label":"KDE Plasma","description":"A familiar, highly customisable desktop with a taskbar and start menu."},{"id":"niri","label":"Niri","description":"A scrollable tiling desktop for keyboard-driven work."}],"bases":[{"id":"yellowfin","label":"AlmaLinux Kitten 10 (flagship)"},{"id":"albacore","label":"AlmaLinux 10"},{"id":"skipjack","label":"CentOS Stream 10"}],"targets":[{"id":"yellowfin:gnome:linux/amd64","base":"yellowfin","desktop":"gnome","platform":"linux/amd64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/yellowfin:gnome","compressedSize":1625549436,"browserQualified":false},{"id":"yellowfin:gnome-nvidia:linux/amd64","base":"yellowfin","desktop":"gnome","platform":"linux/amd64","edition":"standard","hardware":"nvidia","image":"ghcr.io/tuna-os/yellowfin:gnome-nvidia","compressedSize":2625549436,"browserQualified":false},{"id":"yellowfin:gnome:linux/arm64","base":"yellowfin","desktop":"gnome","platform":"linux/arm64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/yellowfin:gnome","compressedSize":1525549436,"browserQualified":false},{"id":"albacore:gnome:linux/amd64","base":"albacore","desktop":"gnome","platform":"linux/amd64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/albacore:gnome","compressedSize":1600000000,"browserQualified":true},{"id":"yellowfin:kde:linux/amd64","base":"yellowfin","desktop":"kde","platform":"linux/amd64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/yellowfin:kde","compressedSize":1800000000,"browserQualified":false},{"id":"skipjack:kde:linux/amd64","base":"skipjack","desktop":"kde","platform":"linux/amd64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/skipjack:kde","compressedSize":1700000000,"browserQualified":false},{"id":"skipjack:niri:linux/amd64","base":"skipjack","desktop":"niri","platform":"linux/amd64","edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/skipjack:niri","compressedSize":1400000000,"browserQualified":false}]}'
    ;;
  drives)
    if [ "$fail" = drives ]; then
      emit '{"event":"error","kind":"permission","message":"Could not list drives."}'
      exit 1
    fi
    if [ "${FAKE_HELPER_DRIVES:-}" = none ]; then
      emit '{"event":"drives","drives":[]}'
    else
      emit '{"event":"drives","drives":[{"id":"fake-usb-0001","path":"/dev/disk9","name":"SanDisk Ultra","sizeBytes":32010928128,"bus":"usb","removable":true,"mounted":["/Volumes/SANDISK"],"systemDisk":false},{"id":"fake-sd-0002","path":"/dev/disk8","name":"Kingston DataTraveler","sizeBytes":15938355200,"bus":"usb","removable":true,"mounted":[],"systemDisk":false}]}'
    fi
    ;;
  build)
    if [ -z "$out" ] || { [ -z "$target" ] && [ -z "$request" ]; }; then
      echo "fake-helper: build needs --out and --target or --request" >&2
      emit '{"event":"error","kind":"usage","message":"Missing arguments."}'
      exit 2
    fi
    echo "fake-helper: building ${target:-$request} into $out" >&2
    phase download 8 bytes 1625549436
    if [ "$fail" = build ]; then
      echo "fake-helper: pretend the network dropped" >&2
      emit '{"event":"error","kind":"network","message":"The download was interrupted. Check your internet connection and try again."}'
      exit 1
    fi
    for p in unpack overlay erofs esp iso; do phase "$p" 2 steps 2; done
    printf 'FAKE-ISO %s\n' "${target:-$request}" >"$out"
    emit "{\"event\":\"done\",\"path\":\"$out\",\"bytes\":24,\"sha256\":\"0000\"}"
    ;;
  write)
    if [ -z "$iso" ] || [ -z "$device" ]; then
      emit '{"event":"error","kind":"usage","message":"Missing arguments."}'
      exit 2
    fi
    if [ ! -f "$iso" ]; then
      emit '{"event":"error","kind":"storage","message":"The ISO file is missing."}'
      exit 1
    fi
    echo "fake-helper: writing $iso to $device (simulated)" >&2
    phase write 6 bytes 3221225472
    if [ "$fail" = write ]; then
      emit '{"event":"error","kind":"device-changed","message":"The USB stick was unplugged or changed. Plug it in again and retry."}'
      exit 1
    fi
    phase verify 4 bytes 3221225472
    emit "{\"event\":\"done\",\"device\":\"$device\",\"bytes\":3221225472,\"verified\":true}"
    ;;
  *)
    echo "usage: fake-helper version|catalog|drives|build|write" >&2
    emit '{"event":"error","kind":"usage","message":"Unknown command."}'
    exit 2
    ;;
esac
exit 0
