#!/usr/bin/env bash
set -euo pipefail

readonly assets_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/assets" && pwd)"
readonly repository="https://github.com/novnc/noVNC.git"
readonly version="v1.6.0"
readonly commit="a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820"
readonly temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT

readonly checkout_dir="$temporary_dir/repository"
readonly source_dir="$temporary_dir/source"

git init --quiet "$checkout_dir"
git -C "$checkout_dir" remote add origin "$repository"
git -C "$checkout_dir" fetch --quiet --depth=1 origin "$commit"
test "$(git -C "$checkout_dir" rev-parse 'FETCH_HEAD^{commit}')" = "$commit"

mkdir "$source_dir"
git -C "$checkout_dir" archive --format=tar "$commit" -- \
    core vendor/pako vnc_lite.html LICENSE.txt AUTHORS |
    tar -xf - -C "$source_dir"

rm -rf -- \
    "$assets_dir/core" \
    "$assets_dir/vendor/pako" \
    "$assets_dir/vnc_lite.html" \
    "$assets_dir/NOVNC-LICENSE.txt" \
    "$assets_dir/NOVNC-AUTHORS"
mkdir -p "$assets_dir/vendor"
cp -a "$source_dir/core" "$assets_dir/"
cp -a "$source_dir/vendor/pako" "$assets_dir/vendor/"
cp -a "$source_dir/vnc_lite.html" "$assets_dir/"
cp "$source_dir/LICENSE.txt" "$assets_dir/NOVNC-LICENSE.txt"
cp "$source_dir/AUTHORS" "$assets_dir/NOVNC-AUTHORS"

cat >"$assets_dir/VENDORED_VERSION" <<EOF
noVNC version: $version
Source: $repository
Commit: $commit
EOF

printf 'Updated noVNC %s (%s) in %s\n' "$version" "$commit" "$assets_dir"
