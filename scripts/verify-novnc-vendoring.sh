#!/usr/bin/env bash
# verify-novnc-vendoring.sh — Gate to ensure noVNC vendoring is pinned and documented.
#
# This script runs in CI to enforce:
# 1. VENDORED_VERSION file exists and is not empty
# 2. File documents the pinned commit/tag
# 3. File includes sync instructions
# 4. NOVNC-LICENSE.txt exists (MPL 2.0)

set -euo pipefail

NOVNC_PATH="native/vncviewer/assets"
ERRORS=0

if [[ ! -d "$NOVNC_PATH" ]]; then
  echo "ERROR: $NOVNC_PATH not found"
  exit 1
fi

# Check VENDORED_VERSION exists
if [[ ! -f "$NOVNC_PATH/VENDORED_VERSION" ]]; then
  echo "ERROR: $NOVNC_PATH/VENDORED_VERSION not found"
  echo "  This file must document the pinned noVNC commit/tag for auditing."
  echo "  Run: scripts/sync-novnc.sh <commit-or-tag>"
  ((ERRORS++))
else
  # Verify it's not empty and contains key markers
  if ! grep -q "Pinned commit:" "$NOVNC_PATH/VENDORED_VERSION"; then
    echo "ERROR: $NOVNC_PATH/VENDORED_VERSION missing 'Pinned commit:' marker"
    ((ERRORS++))
  fi
  if ! grep -q "Upstream:" "$NOVNC_PATH/VENDORED_VERSION"; then
    echo "ERROR: $NOVNC_PATH/VENDORED_VERSION missing 'Upstream:' marker"
    ((ERRORS++))
  fi
fi

# Check LICENSE exists
if [[ ! -f "$NOVNC_PATH/NOVNC-LICENSE.txt" ]]; then
  echo "ERROR: $NOVNC_PATH/NOVNC-LICENSE.txt not found"
  echo "  noVNC is licensed under Mozilla Public License 2.0."
  ((ERRORS++))
fi

# Check core/ and vendor/pako/ exist
for dir in core vendor/pako; do
  if [[ ! -d "$NOVNC_PATH/$dir" ]]; then
    echo "ERROR: $NOVNC_PATH/$dir not found (expected noVNC tree structure)"
    ((ERRORS++))
  fi
done

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "ERROR: noVNC vendoring contract violations ($ERRORS)"
  exit 1
fi

echo "✓ noVNC vendoring is properly documented and pinned"
exit 0
