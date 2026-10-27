# iso-builder #3797 same-byte diagnostic handoff

## Current work

Implementation is in the isolated worktree `/tmp/iso-builder-3797-same-byte`, branch `codex/3797-same-byte-selftest-20261027`, based on `origin/main` at `d14a830`. The user's main worktree and its untracked `.spektacular/` and `e2e/screenshots/` files were left untouched.

The workflow accepts this path only with these inputs: `run_full=true`, `only=skipjack-gnome`, `retain_iso_artifact=true`, `diagnostic_unqualified=true`, `benchmark=false`, `keep_iso=false`, and `retain_candidate=false`. It uses an artifact from the same GitHub run. It needs no cross-repository artifact credential or R2. Before the workflow downloads the artifact, it deletes the local ISO. The strict harness uses the ISO that the workflow rebuilds and checks by hash.

Before the guest starts, `scripts/prepare-browser-selftest.py` checks the downloaded manifest against this run: repository, source SHA, run ID, try number, target, and measurements. It records the upload action's artifact ID and hashes the restored file. It compares that hash with the browser measurement. The script extracts `live-source.json` and `live-installer-info` from the ISO payloads.

The source and overlay IDs must match the browser's `engineBuildResult`. The media receipt supplies the installer digest. The harness uses the digest of the live-media tacklebox executable as its engine ID. The browser WASM digest remains a separate observation. The script records `baseAnnotationMatched`; a false value does not mean that the digest check failed.

The strict path checks out TunaOS harness commit `64da1ea1af6b19487ad9cea85213c41646e3ff7f`. It passes source, overlay, installer, engine, media, target, browser name and version, and same-runner memory and free-disk measurements through `sudo`. It removes `TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE` from the environment before the guest starts. If an identity is missing, the script stops before guest execution. The sidecar and output path stay marked diagnostic-unqualified. This path does not claim producer or frontend authentication, catalog qualification, publication, or a download-route change.

## Files changed

- `.github/workflows/ci.yml`: dispatch rules, round-trip budget, receipt prep, guest test, and diagnostic evidence finalization.
- `scripts/finalize-diagnostic-output.py`: changes nested receipts from qualification to diagnostic names and writes a marker.
- `scripts/prepare-browser-selftest.py`: extracts media receipts and checks identity for the same ISO bytes.
- `tests/test_finalize_diagnostic_output.py`: tests nested receipts and checks the diagnostic marker.
- `tests/test_prepare_browser_selftest.py`: exact-byte, identity, run/try, and installer-receipt behavior.
- `tests/test_iso_artifact_retention.py`: strict-dispatch policy and timeout totals.
- `docs/candidate-retention.md` and `docs/browser-qualification-integration-plan.md`: route, evidence labels, and limits.
- `docs/iso-builder-3797-same-byte-handoff.md`: branch state, verification, and remaining limits.

## Verification and limits

All Python tests passed: 209 passed and 1 skipped. `actionlint .github/workflows/ci.yml` passed. `python3 -m py_compile` passed for both preparation scripts. Pytest warned that it could not remove root-owned files from its temporary garbage directory. I left those files untouched.

A local smoke test built a small ISO. Its SquashFS payload held both TunaOS receipts. The test split the ISO and checked the exact bytes again.

It ran the real payload extractor and input-preparation CLI. The CLI found the installer digest. It kept the engine digest from the media separate from the browser's WASM digest. It wrote the expected artifact ID.

I did not dispatch a workflow or boot a real ISO. AWS credits have run out, but this workflow uses GitHub-hosted runners. No diagnostic run on a hosted runner has checked GitHub quota, KVM access, or runner capacity. Check those limits before dispatch. Do not publish. This does not prove a real desktop or GDM result.

PR #285 remains separate and unmerged. This branch uses its diagnostic fields; it does not repeat browser observation. Both branches change `ci.yml`; combine those edits before you open or stack a PR. If PR #3431 changes before a hosted run, recheck the TunaOS harness pin and receipt extractor.

## Safe dispatch inputs after resources are available

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"diagnostic_unqualified":true,"strict_roundtrip_test":true,"retain_iso_artifact_days":"7"}
```
