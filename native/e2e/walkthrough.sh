#!/bin/bash
# Regenerates the doc screenshots at ../../../docs-assets/native-app/*.png
# (a docs repo checkout must sit next to this one — see --out-dir below).
#
# Same idea as prototype/iso-builder/e2e's `npm run walkthrough` for the
# browser builder, but this is a real desktop GUI (Fyne), not a web page —
# no Playwright here. Instead: a virtual X server (Xvfb) plus xdotool to
# click, and xwd/netpbm to capture. This deliberately avoids trying to
# screenshot a real GNOME/Wayland session — that path was tried during
# development and hits two hard walls: GNOME blocks non-interactive
# screenshot capture by design (the portal needs human consent, and
# Shell's own screenshot D-Bus API denies unprivileged callers), and the
# app renders as a native Wayland surface invisible to X11 tools anyway.
# Xvfb sidesteps both — it's a plain X server this script fully owns.
#
# Requires: Xvfb, xdotool, xwd, netpbm (xwdtopnm/pnmtopng), and a built
# tacklebox-app binary. Linux only (matches the app's own Linux-native
# execution path — no VM/WSL2 involved, so this is fast and needs no
# elevated privileges).
#
# Usage: ./walkthrough.sh [--out-dir DIR]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/screenshots"
DISPLAY_NUM=":97"
GEOMETRY="1280x800x24"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"
WORK_DIR="$(mktemp -d --tmpdir="$NATIVE_DIR" walkthrough-XXXXXX)"
trap 'kill $XVFB_PID $APP_PID 2>/dev/null; rm -rf "$WORK_DIR"' EXIT

echo ">>> Building tacklebox-app..."
APP_BIN="$WORK_DIR/tacklebox-app"
(cd "$NATIVE_DIR" && TMPDIR="$WORK_DIR" GOTMPDIR="$WORK_DIR" go build -o "$APP_BIN" .)

echo ">>> Starting Xvfb on $DISPLAY_NUM..."
Xvfb "$DISPLAY_NUM" -screen 0 "$GEOMETRY" &
XVFB_PID=$!
sleep 2

echo ">>> Launching tacklebox-app..."
TMPDIR="$WORK_DIR" DISPLAY="$DISPLAY_NUM" LIBGL_ALWAYS_SOFTWARE=1 "$APP_BIN" \
  >"$WORK_DIR/app.log" 2>&1 &
APP_PID=$!

echo ">>> Waiting for the window..."
for _ in $(seq 1 20); do
  WIN_ID="$(DISPLAY="$DISPLAY_NUM" xdotool search --name "TunaOS" 2>/dev/null | head -1 || true)"
  [ -n "$WIN_ID" ] && break
  sleep 0.5
done
if [ -z "$WIN_ID" ]; then
  echo "!!! window never appeared, app log:" >&2
  cat "$WORK_DIR/app.log" >&2
  exit 1
fi
sleep 1

# capture <name>: screenshots the current window content, cropped to its
# actual geometry (Xvfb's screen is much larger than the window so this
# avoids huge black borders in the docs).
capture() {
  local name="$1"
  eval "$(DISPLAY="$DISPLAY_NUM" xdotool getwindowgeometry --shell "$WIN_ID")"
  DISPLAY="$DISPLAY_NUM" xwd -root -out "$WORK_DIR/$name.xwd" 2>/dev/null
  xwdtopnm "$WORK_DIR/$name.xwd" 2>/dev/null | pnmtopng 2>/dev/null > "$WORK_DIR/$name-full.png"
  convert "$WORK_DIR/$name-full.png" -crop "${WIDTH}x${HEIGHT}+${X}+${Y}" +repage "$OUT_DIR/$name.png"
  echo "  -> $OUT_DIR/$name.png"
}

click() {
  DISPLAY="$DISPLAY_NUM" xdotool mousemove "$1" "$2" click 1
  sleep 0.5
}

# scroll <x> <y> <ticks>: the OS picker is a real scrollable list (see
# catalog.go), not a dropdown — scroll wheel ticks are how you move
# through it. ~73px/row in the default layout; the multi-org catalog
# entries sit after TunaOS's own ~40-entry variant×desktop matrix.
scroll() {
  local x="$1" y="$2" ticks="$3"
  for _ in $(seq 1 "$ticks"); do
    DISPLAY="$DISPLAY_NUM" xdotool mousemove "$x" "$y" click 5
  done
  sleep 0.3
}

echo ">>> 01-home: initial state"
capture 01-home

echo ">>> 02-os-catalog: scrolled to show a card mid-catalog"
scroll 280 150 20
capture 02-os-catalog

echo ">>> 03-os-selected: an OS card clicked (selection highlight)"
click 280 150
sleep 0.3
capture 03-os-selected

echo ">>> 05-multi-org-catalog: scrolled to the curated multi-org entries"
scroll 280 150 290
capture 05-multi-org-catalog

echo ">>> Done. Screenshots in $OUT_DIR"
