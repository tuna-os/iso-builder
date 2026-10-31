# iso-builder #3797 same-byte diagnostic handoff

## Current work

This worktree integrates PR #315 (`engine/live-source-receipt`, integration head `2e90c45`) with `origin/main` at `b000857` through an uncommitted merge. It uses `/home/ubuntu/tuna-wt/Finish-IsoMerge`, branch `finish/iso-merge`. This work leaves the in-flight run's `/home/ubuntu/tuna-wt/iso-builder` worktree untouched. The merge keeps main's full-plan and cold/warm pair support, the receipt reader, and the short directory for strict diagnostics.

The workflow accepts this path only with these inputs: `run_full=true`, `only=skipjack-gnome`, `retain_iso_artifact=true`, `diagnostic_unqualified=true`, `benchmark=false`, `keep_iso=false`, and `retain_candidate=false`. It uses an artifact from the same GitHub run. It needs no cross-repository artifact credential or R2. Before the workflow downloads the artifact, it deletes the local ISO. The strict harness uses the ISO that the workflow rebuilds and checks by hash.

Before the guest starts, `scripts/prepare-browser-selftest.py` checks the downloaded manifest against this run: repository, source SHA, run ID, try number, target, and measurements. It records the upload action's artifact ID and hashes the restored file. It compares that hash with the browser measurement. The script extracts `live-source.json` and `live-installer-info` from the ISO payloads.

The source and overlay IDs must match the browser's `engineBuildResult`. The media receipt supplies the installer digest. Its engine digest must match the digest of the WASM that the browser loaded. This identifies the browser engine that authored the media, not a live-media tacklebox executable. The script records `baseAnnotationMatched`; a false value does not mean that the digest check failed. Browser live roots use EROFS: the receipt reader supports the uncompressed plain/inline layouts emitted by the engine and fails closed on unsupported layouts.

The strict path checks out TunaOS harness commit `64da1ea1af6b19487ad9cea85213c41646e3ff7f`. It passes source, overlay, installer, engine, media, target, browser name and version, and same-runner memory and free-disk measurements through `sudo`. It removes `TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE` from the environment before the guest starts. If an identity is missing, the script stops before guest execution.

The sidecar uses the diagnostic-unqualified label. The output directory `luks-verify-<slug>-diag` carries the `DIAGNOSTIC-UNQUALIFIED.txt` marker. The harness creates Unix sockets inside this short directory; `sun_path` holds 107 bytes. The recipe fails before the guest starts if the longest socket path would exceed that limit. This path does not claim producer or frontend authentication, catalog qualification, publication, or a download-route change.

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

The following results predate this merge and are not verification of the merge result. This integration ran no gates, builds, formatters, workflow dispatches, or guest boots. The dependency conflicts in `native/go.mod` and `native/go.sum` now use main's tacklebox pin `4b307e7f9b9f`. The merge retains the strict receipt checks and the guard for socket path length.

Historical verification: all Python tests passed: 209 passed and 1 skipped. `actionlint .github/workflows/ci.yml` passed. `python3 -m py_compile` passed for both preparation scripts. Pytest warned that it could not remove root-owned files from its temporary garbage directory. Those files were left untouched.

A local smoke test built a small ISO. Its SquashFS payload held both TunaOS receipts. The test split the ISO and checked the exact bytes again.

That earlier test used the real payload extractor and input-preparation CLI and found the installer digest and expected artifact ID. It predates the browser-engine receipt contract above and does not establish EROFS support or verify this merge.

I did not dispatch a workflow or boot a real ISO. AWS credits have run out, but this workflow uses GitHub-hosted runners. No diagnostic run on a hosted runner has checked GitHub quota, KVM access, or runner capacity. Check those limits before dispatch. Do not publish. This does not prove a real desktop or GDM result.

The merge keeps main's full-plan and cold/warm pair changes. The strict route remains diagnostic only. This integration keeps the existing harness pin and deployment policy.

## Safe dispatch inputs after resources are available

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"diagnostic_unqualified":true,"strict_roundtrip_test":true,"retain_iso_artifact_days":"7"}
```
