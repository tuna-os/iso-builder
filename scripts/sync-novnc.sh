#!/usr/bin/env bash
# sync-novnc.sh — Sync the vendored noVNC tree to a pinned upstream release or commit.
#
# Usage: ./scripts/sync-novnc.sh <commit-sha-or-tag>
#
# This script:
# 1. Clones noVNC temporarily if not present
# 2. Checks out the specified commit or tag
# 3. Verifies the expected module structure (core/, vendor/pako/)
# 4. Copies the tree over native/vncviewer/assets/
# 5. Updates VENDORED_VERSION with the pinned commit
# 6. Reports a diff summary for review before commit

set -euo pipefail

if [[ $# -ne 1 ]]; then
  cat >&2 << 'USAGE'
Usage: ./scripts/sync-novnc.sh <commit-sha-or-tag>

Example:
  ./scripts/sync-novnc.sh v1.4.0
  ./scripts/sync-novnc.sh 9b9e2c6e7f9c2a3d1b4e5f6g7h8i9j0k
USAGE
  exit 1
fi

TARGET_REF="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOVNC_UPSTREAM_DIR="${NOVNC_UPSTREAM_DIR:-.novnc-upstream}"
VENDORED_PATH="$REPO_ROOT/native/vncviewer/assets"

echo "=== noVNC Sync: $TARGET_REF ===" >&2

# Clone or fetch upstream
if [[ ! -d "$NOVNC_UPSTREAM_DIR" ]]; then
  echo "[*] Cloning https://github.com/novnc/noVNC to $NOVNC_UPSTREAM_DIR" >&2
  git clone https://github.com/novnc/noVNC "$NOVNC_UPSTREAM_DIR"
else
  echo "[*] Fetching latest from https://github.com/novnc/noVNC" >&2
  git -C "$NOVNC_UPSTREAM_DIR" fetch origin
fi

# Check out target ref
echo "[*] Checking out $TARGET_REF" >&2
git -C "$NOVNC_UPSTREAM_DIR" checkout "$TARGET_REF"

# Get the commit SHA for pinning
COMMIT_SHA=$(git -C "$NOVNC_UPSTREAM_DIR" rev-parse HEAD)
SHORT_SHA="${COMMIT_SHA:0:12}"

echo "[*] Pinned to commit: $COMMIT_SHA" >&2

# Verify expected structure
for dir in core vendor/pako; do
  if [[ ! -d "$NOVNC_UPSTREAM_DIR/$dir" ]]; then
    echo "ERROR: Expected directory $dir not found in $NOVNC_UPSTREAM_DIR" >&2
    exit 1
  fi
done

# Backup existing for diff
BACKUP_DIR=$(mktemp -d)
cp -r "$VENDORED_PATH" "$BACKUP_DIR/assets-old"
trap "rm -rf $BACKUP_DIR" EXIT

# Sync: Remove old vendoring, copy new
echo "[*] Syncing vendored tree..." >&2
rm -rf "$VENDORED_PATH/core" "$VENDORED_PATH/vendor"
cp -r "$NOVNC_UPSTREAM_DIR/core" "$VENDORED_PATH/core"
cp -r "$NOVNC_UPSTREAM_DIR/vendor/pako" "$VENDORED_PATH/vendor/pako"

# Keep the LICENSE and AUTHORS (already in place, but verify)
if [[ ! -f "$NOVNC_UPSTREAM_DIR/LICENSE.txt" ]]; then
  echo "WARNING: LICENSE.txt not found upstream" >&2
else
  cp "$NOVNC_UPSTREAM_DIR/LICENSE.txt" "$VENDORED_PATH/NOVNC-LICENSE.txt"
fi

# Update VENDORED_VERSION
cat > "$VENDORED_PATH/VENDORED_VERSION" << EOF
noVNC vendored version metadata
================================

Upstream: https://github.com/novnc/noVNC
License: Mozilla Public License 2.0 (see NOVNC-LICENSE.txt)

Pinned commit: $COMMIT_SHA
Pinned ref: $TARGET_REF
Last sync date: $(date -u +%Y-%m-%d)
Sync method: scripts/sync-novnc.sh

TO VERIFY THIS VENDORING:
=========================

Clone noVNC and diff against this tree:
  git clone https://github.com/novnc/noVNC /tmp/novnc-upstream
  cd /tmp/novnc-upstream
  git checkout $COMMIT_SHA
  git diff HEAD:core/ $VENDORED_PATH/core/
  git diff HEAD:vendor/pako/ $VENDORED_PATH/vendor/pako/

TO UPDATE THIS VENDORING:
==========================

1. Identify the target release or commit from https://github.com/novnc/noVNC/releases
2. Run scripts/sync-novnc.sh <commit-sha-or-tag>
3. Review the diff carefully — noVNC's module structure may have changed
4. Update VENDORED_VERSION if the sync script didn't
5. Commit: git commit -s -m "[refactor] novnc: sync to $TARGET_REF"

See scripts/sync-novnc.sh for automation.
EOF

echo >&2
echo "=== Diff Summary ===" >&2
echo >&2
echo "Files added/removed:" >&2
diff -r "$BACKUP_DIR/assets-old" "$VENDORED_PATH" --brief 2>/dev/null | head -20 || true
echo >&2
echo "VENDORED_VERSION updated to:" >&2
cat "$VENDORED_PATH/VENDORED_VERSION"
echo >&2
echo "Next: Review the diff, then commit with:" >&2
echo "  git add native/vncviewer/assets/" >&2
echo "  git commit -s -m \"[refactor] novnc: sync to $TARGET_REF ($SHORT_SHA)\"" >&2
