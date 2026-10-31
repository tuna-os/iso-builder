# iso-builder #3797 same-byte diagnostic handoff

## Current work

PR #315 (`engine/live-source-receipt`, head `41cf9740`) is integrated with `origin/main` at `8c026b9` in `/home/ubuntu/tuna-wt/Finish-IsoMerge`, branch `finish/iso-merge`, as an uncommitted merge. The in-flight run's `/home/ubuntu/tuna-wt/iso-builder` worktree is untouched. Main's full-plan and cold/warm pair support are retained alongside the receipt reader and short strict diagnostic directory.

The workflow accepts this path only with these inputs: `run_full=true`, `only=skipjack-gnome`, `retain_iso_artifact=true`, `diagnostic_unqualified=true`, `benchmark=false`, `keep_iso=false`, and `retain_candidate=false`. It uses an artifact from the same GitHub run. It needs no cross-repository artifact credential or R2. Before the workflow downloads the artifact, it deletes the local ISO. The strict harness uses the ISO that the workflow rebuilds and checks by hash.

Before the guest starts, `scripts/prepare-browser-selftest.py` checks the downloaded manifest against this run: repository, source SHA, run ID, try number, target, and measurements. It records the upload action's artifact ID and hashes the restored file. It compares that hash with the browser measurement. The script extracts `live-source.json` and `live-installer-info` from the ISO payloads.

The source and overlay IDs must match the browser's `engineBuildResult`. The media receipt supplies the installer digest. Its engine digest must match the loaded browser WASM digest; this identifies the browser engine that authored the media, not a live-media tacklebox executable. The script records `baseAnnotationMatched`; a false value does not mean that the digest check failed. Browser live roots use EROFS: the receipt reader supports the uncompressed plain/inline layouts emitted by the engine and fails closed on unsupported layouts.

The strict path checks out TunaOS harness commit `64da1ea1af6b19487ad9cea85213c41646e3ff7f`. It passes source, overlay, installer, engine, media, target, browser name and version, and same-runner memory and free-disk measurements through `sudo`. It removes `TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE` from the environment before the guest starts. If an identity is missing, the script stops before guest execution. The sidecar is labelled diagnostic-unqualified, and the output directory `luks-verify-<slug>-diag` carries the `DIAGNOSTIC-UNQUALIFIED.txt` marker. The directory name is short because the harness binds Unix sockets inside it and `sun_path` holds 107 bytes; the recipe fails before the guest starts if the longest socket path would exceed that. This path does not claim producer or frontend authentication, catalog qualification, publication, or a download-route change.

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

The following results predate this merge and are not verification of the merge result. No gates, builds, formatters, workflow dispatches, or guest boots were run for this integration. The dependency conflicts in `native/go.mod` and `native/go.sum` retain the PR's tacklebox pin `35238529c8d2`, rather than main's `a9a744e95f29`, to avoid changing pins.

Historical verification: all Python tests passed: 209 passed and 1 skipped. `actionlint .github/workflows/ci.yml` passed. `python3 -m py_compile` passed for both preparation scripts. Pytest warned that it could not remove root-owned files from its temporary garbage directory. Those files were left untouched.

A local smoke test built a small ISO. Its SquashFS payload held both TunaOS receipts. The test split the ISO and checked the exact bytes again.

That historical smoke test ran the real payload extractor and input-preparation CLI and found the installer digest and expected artifact ID. It predates the browser-engine receipt contract above and does not establish EROFS support or verify this merge.

I did not dispatch a workflow or boot a real ISO. AWS credits have run out, but this workflow uses GitHub-hosted runners. No diagnostic run on a hosted runner has checked GitHub quota, KVM access, or runner capacity. Check those limits before dispatch. Do not publish. This does not prove a real desktop or GDM result.

Main's full-plan and cold/warm pair changes are now integrated. The strict route remains diagnostic only; its existing pins and deployment policy are unchanged.

## Safe dispatch inputs after resources are available

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"diagnostic_unqualified":true,"strict_roundtrip_test":true,"retain_iso_artifact_days":"7"}
```
