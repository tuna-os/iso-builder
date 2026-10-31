# iso-builder #3797 same-byte diagnostic handoff

## Current work

Recovery implementation is in the isolated worktree `~/tuna-wt/Finish-RetainedRecovery`, based on fetched `origin/main` at `b000857`. The same-run implementation notes below describe the earlier path; the retained-run recovery route is documented at the end.

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

## Recover run 41153841817 without rebuilding

Run [41153841817](https://github.com/tuna-os/iso-builder/actions/runs/41153841817)
built the browser ISO, then failed in `download-artifact@v8` after five
retries (25 seconds). The subsequent missing `manifest.json` was a dependent
transport error, not a guest verdict. The runner still had 74 GiB free.
The normal round-trip verify step now requires successful download; the
original download failure remains fatal.

TunaOS `iso-e2e.yml` exposes only `r2-latest` and `build`, not a working
artifact source. This workflow therefore has one bounded opt-in
`recover_retained_iso` route for these exact retained bytes. It uses the
existing three consumer recipes: `iso-artifact-verify`,
`full-strict-inputs`, and `full-guest-verify-strict`. It never rebuilds a
browser ISO or engine, publishes, deploys, uses R2, or needs a new secret.
All build/publish inputs must remain false.

After the parent validates and publishes this branch, dispatch it on GitHub's
Linux/KVM runner (the parent's current host lacks `/dev/kvm`):

```bash
gh workflow run ci.yml -R tuna-os/iso-builder \
  --ref <published-recovery-branch> -f recover_retained_iso=true
```

The recovery job authenticates GitHub API metadata before and after archive
collection, including original run ID `41153841817`, attempt `1`, source SHA
`41cf974098ef5a90c9a73fd3942ed0abeb0c8058`, repository ID, artifact ID,
name, expiry, archive size and SHA-256. A failed original run is expected and
does not prevent recovery. A changed attempt, expired artifact or mismatch
fails closed. The download uses the existing authenticated `gh api` ZIP
transport without added retries. No dependent verifier runs after download
failure.

The hard-bound ISO artifact is `13027183695`, archive size `11452406380`,
archive hash
`sha256:057c98786f98d78eaa03edee9c9db48a54499f3a146940a4ffcb4deea79ff04b`.
The original browser evidence is artifact `13027593918`, archive size
`2623`, archive hash
`sha256:c24cdca4d2eb0866864c8acbb83825951b031a3d9613c462d91731eb157f333e`.
Archive digests authenticate manifest, chunks and evidence before extraction.
Every chunk and the restored ISO must verify against the original manifest
and independently recorded ISO hash
`sha256:1676d57d19a9041c9e919843137c96e54ebeeaeebf8068b602aa3da7f16a8810`.

The existing EROFS receipt consumer from PR #315 at
`2e90c45e7eaa8cec052ccee5a448c0b733ebe48e` is included here. It binds the
manifest's original producer/run/attempt/source SHA, browser measurements,
target and source/overlay/installer/WASM receipts from the exact ISO. It
does not substitute the recovery branch's engine or source identity. The
strict consumer uses a short socket path and checks its actual length.
The recovery job checks out the explicitly approved strict harness from tunaOS
PR #4044 at immutable revision `6c67e774313432a2d5cbfc29328cf5bf0b9b16ea`
and records the checked-out SHA before running the strict guest driver.
There is no mutable-main fallback: tunaOS main does not yet include this
strict driver and payload extractor.

Host observations now explicitly carry `measurementOrigin: recovery-host`
and `measuredOnBrowserRunner: false` for a different repository/run/attempt
or absent execution identity. Only the matching original producer-run
context retains `true`. These are recovery-host resource measurements, not
original browser-host qualification evidence.

Recovery uploads original browser evidence, authenticated transport metadata,
manifest, round-trip verification, media/identity binding and diagnostic
guest output even on failure. Finalization does not suppress guest failure.
Transport/preparation success is not guest acceptance: only the actual
strict install, detached cold and warm run can establish its guest verdict.
All results remain diagnostic-unqualified; producer/frontend authentication
and catalog qualification are not claimed.

After evidence upload, the existing job-scoped cleanup removes the restored
ISO and chunks, short `luks-verify-<slug>-diag` tree (including guest disks,
swtpm state and SSH keys), and processes carrying those exact owned paths.
Other cells, runs and similarly prefixed sibling directories are not owned.

For a manual execution on a suitable Linux/KVM host, use a fresh private
short checkout such as `~/tuna-wt/ir`, not `/tmp`. The workflow is the
supported parent execution route here. No retained ISO download or guest
execution was performed while implementing this recovery.

