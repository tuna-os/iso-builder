# iso-builder task runner.
#
# Every recipe here is what a CI step used to inline in
# .github/workflows/ci.yml; the workflow keeps only the thin wrappers
# (checkout, setup, artifact transfer, deploy, anything bearing secrets).
# Recipes read their configuration from the environment the workflow step
# sets (SLUG, BENCHMARK, QUALIFY, ...), exactly as the inline scripts did, so a
# step's `env:` block remains the one place its inputs are visible.
#
# Written for the `just` that Ubuntu's apt ships (1.21): shebang recipes and
# plain recipes only, nothing newer. native/justfile is a separate, unrelated
# file for the desktop app's packaging.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# ── CI cleanup and reaping ─────────────────────────────────────────────────

# Job-scoped cleanup for an `if: always()` step. Removes only what THIS run
# created (its own ISOs and scratch under $RUNNER_TEMP, its run-scoped
# Playwright profile, its luks-verify-<SLUG> harness dirs, Playwright output,
# and the QEMU/swtpm/Chromium processes started against those paths). Safe to
# run when nothing exists; refuses (exit 1) rather than delete a path outside
# its roots. SLUG may be a comma-separated list; DRY_RUN=1 only prints.
# Remove this job's own ISOs, scratch, harness output and processes.
ci-cleanup:
    python3 scripts/ci-cleanup.py

# Cancel stuck runs and delete old runs/expired artifacts through `gh api`.
# Env: STALE_QUEUED_HOURS (6), STALE_RUNNING_HOURS (12), KEEP_RUN_DAYS (14),
# DRY_RUN=1 prints only. Needs GH_TOKEN with actions: write and
# GITHUB_REPOSITORY (or REPO). Never touches the newest run per
# workflow+branch, its own run, or young default-branch pushes.
# Cancel stuck runs; delete old runs and expired artifacts.
ci-reap-stale:
    python3 scripts/ci-reap-stale.py

# ── Local checks ───────────────────────────────────────────────────────────

# Python contract/unit tests (what qualification-contract runs in CI).
test:
    python3 -m pytest -q tests

# Node unit tests that run offline (builder config, guided catalog, relay shim).
test-node:
    node --test tests/ worker/

# Everything that runs offline.
check: test test-node

# ── wasm job ───────────────────────────────────────────────────────────────

# Expand native/go.mod's abbreviated tacklebox pin to a full commit SHA via
# the API (actions/checkout cannot resolve a 12-char pseudo-version). Writes
# `commit=<sha>` to $GITHUB_OUTPUT when set. Needs GH_TOKEN.
# Resolve the pinned tacklebox commit SHA.
wasm-resolve-pin:
    #!/usr/bin/env bash
    set -euo pipefail
    cd native
    ver=$(go list -m -f '{{{{.Version}}' github.com/tuna-os/tacklebox)
    short=${ver##*-}
    full=$(gh api "repos/tuna-os/tacklebox/commits/${short}" --jq .sha)
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
        echo "commit=${full}" >> "$GITHUB_OUTPUT"
    fi
    echo "pinned tacklebox ${ver} -> ${short} -> ${full}"

# Build tbox.wasm from the checked-out tacklebox (.tacklebox), take
# wasm_exec.js from the same toolchain so the shim matches the compiler, and
# report both.
# Build tbox.wasm and wasm_exec.js from the pinned tacklebox.
wasm-build:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{justfile_directory()}}"
    (cd .tacklebox && GOOS=js GOARCH=wasm go build -o "${root}/app/public/tbox.wasm" ./cmd/tbwasm)
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" app/public/wasm_exec.js
    ls -l app/public/tbox.wasm app/public/wasm_exec.js

# ── e2e + full-matrix: shared browser setup ────────────────────────────────

# Install the Playwright deps and chromium. CACHE_HIT=true (the
# actions/cache output) skips the browser download and installs only the OS
# libraries.
# Install Playwright deps and chromium.
e2e-install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e
    npm ci
    if [ "${CACHE_HIT:-}" != "true" ]; then
      npx playwright install --with-deps chromium
    else
      npx playwright install-deps chromium
    fi

# The merge gate: page load + inspect only, no ISO written. The browser
# profile root is scoped to this run so ci-cleanup can own it.
# Run the browser merge gate (no @full).
e2e-gate:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "${RUNNER_TEMP:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
      export TBOX_E2E_PROFILE_ROOT="${TBOX_E2E_PROFILE_ROOT:-${RUNNER_TEMP}/pw-profile-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}}"
    fi
    cd e2e
    npx playwright test --grep-invert @full

# ── full-matrix ────────────────────────────────────────────────────────────

# Resolve e2e/editions.json into the matrix, honouring the dispatch inputs
# (ONLY, RUN_FULL, KEEP_ISO, ...). Output is `editions=`/`count=` lines:
#   just --quiet full-plan >> "$GITHUB_OUTPUT"
# Resolve the full-matrix plan from the dispatch inputs.
full-plan:
    python3 scripts/plan-full-matrix.py

# Build the edition in the browser (@full). Benchmark mode (BENCHMARK=true)
# takes three paired samples. The guest-verify step expects ${SLUG}.iso: the
# last sample is kept there and the others are dropped (multi-GB, never
# retained). Needs SLUG and RUNNER_TEMP; the TBOX_E2E_* build env comes from
# the workflow step.
# Build the edition's ISO in the browser (@full).
full-build:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "${GITHUB_RUN_ID:-}" ]; then
      export TBOX_E2E_PROFILE_ROOT="${TBOX_E2E_PROFILE_ROOT:-${RUNNER_TEMP}/pw-profile-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}}"
    fi
    cd e2e
    # Benchmark mode: three paired @full samples per edition; the
    # spec writes one QualificationEvidence v1 file per sample and
    # the evidence step below merges median/range.
    if [ "${BENCHMARK:-}" = "true" ]; then SAMPLES="1 2 3"; else SAMPLES="1"; fi
    for s in $SAMPLES; do
      echo "=== @full sample ${s} ==="
      TBOX_E2E_SAMPLE="${s}" \
        TBOX_E2E_ISO_COPY="${RUNNER_TEMP}/${SLUG}-s${s}.iso" \
        TBOX_E2E_EVIDENCE="test-results/qual-evidence-${SLUG}-s${s}.json" \
        npx playwright test --grep @full --timeout=4500000
    done
    # The guest-verify step below expects ${SLUG}.iso: keep the last
    # sample there and drop the rest (multi-GB; never retained).
    last="${SAMPLES##* }"
    cp "${RUNNER_TEMP}/${SLUG}-s${last}.iso" "${RUNNER_TEMP}/${SLUG}.iso"
    for s in $SAMPLES; do
      if [ "${s}" != "${last}" ]; then rm -f "${RUNNER_TEMP}/${SLUG}-s${s}.iso"; fi
    done

# Install the built ISO under QEMU with LUKS and verify the installed system
# reboots (tunaOS scripts/iso-e2e.sh from the pinned tunaos-e2e checkout).
# Env: SLUG, QUALIFY, TBOX_E2E_IMAGE.
# Install and boot the built ISO under QEMU (LUKS or strict GUI).
full-guest-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    ISO="${RUNNER_TEMP}/${SLUG}.iso"
    if [ ! -f "$ISO" ]; then
      echo "::error::ISO file $ISO was not produced by Playwright build"
      exit 1
    fi

    echo "Installing QEMU, OVMF, swtpm dependencies..."
    sudo apt-get update -qq
    # imagemagick (magick/convert/compare), tesseract-ocr and sshpass are
    # what the strict walkthrough measures with. Without them it reports
    # stddev 0.0 for every frame and skips screen detection, so a guest that
    # painted fine is reported blank (run 40235407606). jq is used by the
    # harness's evidence printing.
    sudo apt-get install -y --no-install-recommends \
      qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools socat netpbm python3-pil \
      imagemagick tesseract-ocr sshpass jq

    echo "Enabling KVM permissions..."
    echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | \
      sudo tee /etc/udev/rules.d/99-kvm4all.rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger --name-match=kvm || true

    # Qualification targets run Task 11's strict offline-GUI
    # contract; upstream pipeline references keep the LUKS check.
    # sudo sanitizes the environment; the VAR=val prefix carries the
    # image ref through to the harness.
    if [ "${QUALIFY}" = "true" ]; then
      echo "Running strict offline-GUI verification..."
      sudo env -u TBOX_E2E_IMAGE "${GITHUB_WORKSPACE}/tunaos-e2e/scripts/iso-e2e.sh" "$ISO" --strict-offline-gui \
        --output "luks-verify-${SLUG}" \
        --timeout 900
    else
      echo "Running LUKS installation and reboot verification..."
      sudo TBOX_E2E_IMAGE="$TBOX_E2E_IMAGE" "${GITHUB_WORKSPACE}/tunaos-e2e/scripts/iso-e2e.sh" "$ISO" --luks \
        --output "luks-verify-${SLUG}" \
        --timeout 900
    fi

    echo "Guest verification completed successfully!"

# Split the built ISO into hash-pinned chunks for the GitHub artifact route
# and publish the browser-measured ISO hash as `iso_sha256=` in $GITHUB_OUTPUT.
# Env: SLUG (plus the GITHUB_* defaults). No secrets.
# Split the ISO into hash-pinned chunks for the artifact route.
iso-artifact-split:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 scripts/retain-iso-artifact.py split \
      --iso "$RUNNER_TEMP/${SLUG}.iso" \
      --measurements "e2e/test-results/build-measurements-qual-evidence-${SLUG}-s1.json" \
      --out "$RUNNER_TEMP/iso-artifact" --slug "$SLUG" \
      --repository "$GITHUB_REPOSITORY" --run-id "$GITHUB_RUN_ID" \
      --run-attempt "$GITHUB_RUN_ATTEMPT" --sha "$GITHUB_SHA" \
      > "$RUNNER_TEMP/iso-artifact-manifest.json"
    mkdir -p e2e/test-results/iso-artifact-manifest
    cp "$RUNNER_TEMP/iso-artifact/manifest.json" e2e/test-results/iso-artifact-manifest/manifest.json
    # Expected hash comes from the browser measurement, not from the manifest under test.
    iso_sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["iso"]["sha256"])' "e2e/test-results/build-measurements-qual-evidence-${SLUG}-s1.json")
    echo "iso_sha256=${iso_sha}" >> "$GITHUB_OUTPUT"

# Free the local copy first so the round trip reads GitHub's bytes, not ours.
# The strict route also drops the original ISO. Env: SLUG, STRICT_ROUNDTRIP_TEST.
# Drop the local ISO chunks before the artifact round trip.
iso-artifact-drop-local:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf "$RUNNER_TEMP/iso-artifact" "$RUNNER_TEMP/iso-roundtrip"
    if [ "$STRICT_ROUNDTRIP_TEST" = "true" ]; then
      rm -f "$RUNNER_TEMP/${SLUG}.iso"
    fi

# Re-verify the downloaded artifact chunk by chunk and as a whole against the
# browser measurement, and write the step summary. Env: SLUG, ARTIFACT,
# ISO_SHA256, ARTIFACT_ID, STRICT_ROUNDTRIP_TEST, RETAIN_ISO_ARTIFACT_DAYS.
# Verify the downloaded ISO artifact against the browser measurement.
iso-artifact-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    output_args=()
    if [ "$STRICT_ROUNDTRIP_TEST" = "true" ]; then
      output_args=(--output "$RUNNER_TEMP/${SLUG}-roundtrip.iso")
    fi
    python3 scripts/retain-iso-artifact.py verify --dir "$RUNNER_TEMP/iso-roundtrip" \
      --expected-sha256 "$ISO_SHA256" "${output_args[@]}" > "$RUNNER_TEMP/iso-roundtrip-result.json"
    {
      echo "### ISO retained as GitHub artifact (diagnostic, not qualified)"
      echo ""
      echo "- artifact: \`${ARTIFACT}\` (id ${ARTIFACT_ID}), retention ${RETAIN_ISO_ARTIFACT_DAYS} day(s)"
      echo "- ISO sha256: \`${ISO_SHA256}\`"
      echo "- downloaded again and re-verified chunk by chunk and as a whole against the browser measurement"
      echo '```json'
      cat "$RUNNER_TEMP/iso-roundtrip-result.json"
      echo '```'
      echo "Fetch: \`gh run download ${GITHUB_RUN_ID} -R ${GITHUB_REPOSITORY} -n ${ARTIFACT}\` then \`python3 scripts/retain-iso-artifact.py verify --dir <dir> --expected-sha256 <browser-measured hash> --output ${SLUG}.iso\`."
    } >> "$GITHUB_STEP_SUMMARY"

# Derive the strict-guest inputs from the round-tripped media receipts and
# export them to later steps through $GITHUB_ENV. Env: SLUG, EDITION_REF,
# PLATFORM, ARTIFACT_NAME, ARTIFACT_ID, REPOSITORY, RUN_ID, RUN_ATTEMPT,
# SOURCE_SHA.
# Derive strict-guest inputs from the round-tripped media receipts.
full-strict-inputs:
    #!/usr/bin/env bash
    set -euo pipefail
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends \
      xorriso squashfs-tools qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools socat \
      netpbm python3-pil imagemagick tesseract-ocr sshpass jq
    IFS=: read -r variant flavor <<< "$EDITION_REF"
    iso="$RUNNER_TEMP/${SLUG}-roundtrip.iso"
    python3 scripts/prepare-browser-selftest.py \
      --iso "$iso" \
      --measurements "e2e/test-results/build-measurements-qual-evidence-${SLUG}-s1.json" \
      --browser-evidence "e2e/test-results/qual-evidence-${SLUG}-s1.json" \
      --manifest "$RUNNER_TEMP/iso-roundtrip/manifest.json" \
      --payload-extractor "$GITHUB_WORKSPACE/tunaos-e2e-current/scripts/extract-iso-payloads.py" \
      --repository "$REPOSITORY" --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT" \
      --source-sha "$SOURCE_SHA" --artifact-id "$ARTIFACT_ID" --artifact-name "$ARTIFACT_NAME" \
      --variant "$variant" --flavor "$flavor" --slug "$SLUG" --platform "$PLATFORM" \
      --out-env "$RUNNER_TEMP/same-byte-inputs.env" \
      --out-binding "e2e/test-results/same-byte-guest-test-binding-${SLUG}.json"
    cat "$RUNNER_TEMP/same-byte-inputs.env" >> "$GITHUB_ENV"
    {
      echo "### Same-byte strict guest test inputs (diagnostic only)"
      echo "Media receipts, browser measurements, run/attempt and artifact id matched. This does not qualify the target."
      cat "e2e/test-results/same-byte-guest-test-binding-${SLUG}.json"
    } >> "$GITHUB_STEP_SUMMARY"

# Run the exact retained ISO under the current strict harness (diagnostic,
# never a qualification). The TUNAOS_QUAL_* identities come from
# $GITHUB_ENV, written by full-strict-inputs. Env: SLUG.
# Run the exact retained ISO under the current strict harness.
full-guest-verify-strict:
    #!/usr/bin/env bash
    set -euo pipefail
    ISO="$RUNNER_TEMP/${SLUG}-roundtrip.iso"
    if [ ! -f "$ISO" ]; then
      echo "::error::Verified round-trip ISO is missing: $ISO"
      exit 1
    fi
    echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | \
      sudo tee /etc/udev/rules.d/99-kvm4all.rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger --name-match=kvm || true
    sudo env -u TBOX_E2E_IMAGE -u FISHERMAN_OVERRIDE \
      VARIANT="$VARIANT" FLAVOR="$FLAVOR" \
      TUNAOS_QUAL_EXECUTION_KIND="$TUNAOS_QUAL_EXECUTION_KIND" \
      STRICT_PUBLISHED_MEDIA="$STRICT_PUBLISHED_MEDIA" \
      TUNAOS_QUAL_SOURCE_DIGEST="$TUNAOS_QUAL_SOURCE_DIGEST" \
      TUNAOS_QUAL_SOURCE_REF="$TUNAOS_QUAL_SOURCE_REF" \
      TUNAOS_QUAL_OVERLAY_DIGEST="$TUNAOS_QUAL_OVERLAY_DIGEST" \
      TUNAOS_QUAL_INSTALLER_DIGEST="$TUNAOS_QUAL_INSTALLER_DIGEST" \
      TUNAOS_QUAL_ENGINE_DIGEST="$TUNAOS_QUAL_ENGINE_DIGEST" \
      TUNAOS_QUAL_MEDIA_DIGEST="$TUNAOS_QUAL_MEDIA_DIGEST" \
      TUNAOS_QUAL_PLATFORM="$TUNAOS_QUAL_PLATFORM" \
      TUNAOS_QUAL_CPU_BASELINE="$TUNAOS_QUAL_CPU_BASELINE" \
      TUNAOS_QUAL_HARDWARE_SCOPE="$TUNAOS_QUAL_HARDWARE_SCOPE" \
      TUNAOS_QUAL_BROWSER_NAME="$TUNAOS_QUAL_BROWSER_NAME" \
      TUNAOS_QUAL_BROWSER_VERSION="$TUNAOS_QUAL_BROWSER_VERSION" \
      TUNAOS_QUAL_BROWSER_MEMORY_GIB="$TUNAOS_QUAL_BROWSER_MEMORY_GIB" \
      TUNAOS_QUAL_BROWSER_FREE_DISK_GIB="$TUNAOS_QUAL_BROWSER_FREE_DISK_GIB" \
      "$GITHUB_WORKSPACE/tunaos-e2e-current/scripts/iso-e2e.sh" "$ISO" --strict-offline-gui \
      --output "luks-verify-${SLUG}-same-byte-diagnostic-unqualified" --timeout 900
    {
      echo "### Same-byte strict guest test completed (diagnostic, not qualified)"
      echo "- ISO: \`${TUNAOS_QUAL_MEDIA_DIGEST}\`"
      echo "- Browser test diagnostics and media-bound identities are attached; producer/frontend authentication remains absent."
    } >> "$GITHUB_STEP_SUMMARY"

# The guest harness runs under sudo, so its output starts root-owned. Label
# the strict receipt first, then hand the tree back to the runner user so
# upload-artifact can read it. Env: SLUG, STRICT_ROUNDTRIP_TEST.
# Label diagnostic output and hand harness output back to the runner user.
full-label-output:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$STRICT_ROUNDTRIP_TEST" = "true" ]; then
      sudo python3 scripts/finalize-diagnostic-output.py \
        "luks-verify-${SLUG}-same-byte-diagnostic-unqualified"
    fi
    shopt -s nullglob
    dirs=(luks-verify-*/)
    if [ "${#dirs[@]}" -gt 0 ]; then
      sudo chown -R "$(id -u):$(id -g)" "${dirs[@]}"
    fi

# Validate the browser QualificationEvidence v1 files (and merge the three
# benchmark samples). Env: SLUG, BENCHMARK.
# Validate browser qualification evidence; merge benchmark samples.
full-validate-evidence:
    #!/usr/bin/env bash
    set -euo pipefail
    cd e2e
    python3 ../scripts/validate-qualification-evidence.py
