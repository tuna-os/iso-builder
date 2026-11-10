#!/usr/bin/env bash
# Builds tunaos-media-helper and its sibling engine (tacklebox cmd/purebuild,
# at the module version pinned by desktop/helper/go.mod, built by the helper's
# cmd/build-engine) for darwin arm64 and amd64 and lipo's each into a
# universal binary.
#
#   scripts/build-helper.sh [OUT_DIR]     (default build/helper)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/build/helper}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
helper_src="$here/../helper"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

for arch in arm64 amd64; do
  mkdir -p "$scratch/$arch"
  (
    cd "$helper_src"
    CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath \
      -o "$scratch/$arch/tunaos-media-helper" ./cmd/tunaos-media-helper
    # build-engine cross-compiles inside tacklebox's own module itself, so it
    # runs for the host (no GOOS/GOARCH in its environment).
    go run ./cmd/build-engine -goos darwin -goarch "$arch" \
      -o "$scratch/$arch/tunaos-media-engine"
  )
done

for bin in tunaos-media-helper tunaos-media-engine; do
  lipo -create -output "$out/$bin" "$scratch/arm64/$bin" "$scratch/amd64/$bin"
  lipo -info "$out/$bin"
done
