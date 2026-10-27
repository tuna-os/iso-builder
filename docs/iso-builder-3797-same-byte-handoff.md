# iso-builder #3797 same-byte diagnostic handoff

## Current work

Implementation is in the isolated worktree `/tmp/iso-builder-3797-same-byte`, branch `codex/3797-same-byte-selftest-20261027`, based on `origin/main` at `d14a830`. The user's main worktree and its untracked `.spektacular/` and `e2e/screenshots/` files were left untouched.

The opt-in `strict_roundtrip_test` workflow path is bounded to `run_full=true`, `only=skipjack-gnome`, `retain_iso_artifact=true`, `diagnostic_unqualified=true`, `benchmark=false`, `keep_iso=false`, and `retain_candidate=false`. It uses the same run's GitHub artifact, not a cross-repository artifact credential or R2. The original local ISO is removed before artifact download; the hash-verified reassembled output is the ISO passed to the strict harness.

Before guest execution, `scripts/prepare-browser-selftest.py` checks run/repository/source-SHA/attempt/target/measurements against the downloaded manifest, records the current upload action's artifact ID, hashes the restored bytes, and checks them against the browser measurement. It extracts `live-source.json` and `live-installer-info` from the ISO payloads. Source and overlay identities must match the browser's `engineBuildResult`; the installer digest must come from the media receipt. The live-media tacklebox executable digest is passed as the harness engine identity; the loaded browser WASM digest remains a separate observation. `baseAnnotationMatched` is recorded without treating `false` as a failed digest match.

The strict path checks out TunaOS harness commit `64da1ea1af6b19487ad9cea85213c41646e3ff7f`. It passes source, overlay, installer, engine, media, target, browser name/version and measured same-runner memory/free disk explicitly through `sudo`, while unsetting `TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE`. Missing identities fail before guest execution. The sidecar and output path remain diagnostic-unqualified; no producer/frontend authentication, catalog qualification, publication, or download-route change is claimed.

## Files changed

- `.github/workflows/ci.yml`: opt-in dispatch validation, exact round-trip output, current harness checkout, receipt preparation and strict guest path.
- `scripts/prepare-browser-selftest.py`: media receipt extraction and fail-closed same-byte identity join.
- `tests/test_prepare_browser_selftest.py`: exact-byte, identity, run-attempt and installer-receipt behavior.
- `tests/test_iso_artifact_retention.py`: bounded strict-dispatch policy checks.
- `docs/candidate-retention.md` and `docs/browser-qualification-integration-plan.md`: route and limits.
- `docs/iso-builder-3797-same-byte-handoff.md`: branch state, verification and remaining limits.

## Verification and limits

The focused suite passed (35 tests); the full Python suite passed (`205 passed, 1 skipped`). `actionlint .github/workflows/ci.yml` and `python3 -m py_compile scripts/prepare-browser-selftest.py` completed cleanly. Pytest warned that root-owned files in its temporary garbage directory could not be removed; I left them untouched.

A local smoke built a tiny ISO containing a real SquashFS with both TunaOS receipts, split and re-verified the exact ISO bytes, then ran the actual payload extractor and input-preparation CLI. It recovered the installer digest, kept the media engine digest distinct from browser WASM, and emitted a diagnostic binding for the expected artifact ID. No workflow was dispatched and no real ISO was booted. AWS credits are exhausted; do not dispatch or publish. No real desktop/GDM result is established.

The browser candidate-admission PR #285 remains separate and unmerged. This work consumes its existing diagnostic fields rather than reimplementing browser observation, but both branches touch `ci.yml`; reconcile the workflow edits before opening or stacking a PR. The TunaOS strict-harness pin and receipt extractor should be rechecked if #3431 changes before a hosted run.

## Safe dispatch inputs after resources are available

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"diagnostic_unqualified":true,"strict_roundtrip_test":true,"retain_iso_artifact_days":"7"}
```
