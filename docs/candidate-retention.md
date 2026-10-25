# Opt-in browser candidate retention

This retains diagnostic bytes, not release media or a qualified target.
It changes no download link, bucket access, credential, or cleanup policy.
No automatic expiry exists. Stored and incomplete candidates may incur storage
charges until separately authorized removal. Source inspection does not establish
account quota, charges or access settings.

## Dispatch exactly one candidate

Use `.github/workflows/ci.yml` at an immutable frontend revision that you have reviewed:

```json
{"run_full":true,"only":"yellowfin-gnome","benchmark":false,"keep_iso":false,"retain_candidate":true}
```

Retention defaults false. Before full-matrix runs, the plan rejects other targets,
multiple targets, benchmark mode, and concurrent publication through the legacy R2 path.
Missing R2 configuration or an S3 SDK without conditional PUT support fails
before the expensive browser build. No dispatch occurs on push or PR.

Retention can save a successful browser build even after a failure in the guest check.
The guest failure stays a workflow failure; successful retention does not qualify it.
Retention rejects a failed browser build without complete byte measurements.
Runner loss, job cancellation or an exhausted job budget can prevent retention.
Only verification of the result file proves that retention ran.

The workflow preserves the budgets for browser builds and guest checks.
Opt-in retention adds a five-minute dependency/configuration preflight and a
twenty-minute upload/readback step, with corresponding job headroom.
These explicit I/O budgets do not relax the watchdogs for builds or boots.

## Storage format and bounds

The R2 bucket uses the existing secrets. Each pair of run ID and `run-attempt` has one slot:

```
browser-iso/candidates/<run-id>/<run-attempt>/yellowfin-gnome/s1/
  chunks/00000
  chunks/00001
  ...
  manifest.json
```

The slot does not depend on the ISO hash.
A different candidate in the same run and `run-attempt` cannot use another directory based on its hash.
The limits are 10 GiB of ISO bytes and 1 MiB for the combined manifest/provenance.
Chunks are at most 64 MiB, with at most 160 chunks.
The original ISO SHA-256 and byte count bind the ordered chunks.
The split into chunks does not change the ISO.

Every object uses `PutObject` with `If-None-Match: *`.
Cloudflare documents this as atomic against committed bucket state in its
[S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/).
Do not assume that multipart completion provides the same condition.
The implementation never falls back to an unconditional write.

The script refuses a nonempty slot and fails on an atomic conflict.
It does not resume or overwrite. The SDK does not retry.
There are no deletes, ACL writes or lifecycle changes.

The script reads back each uploaded chunk and verifies its size/SHA-256.
The combined SHA-256 must match the independent measurement of the ISO exported from the browser.
Only then does it write `manifest.json` as the commit marker, conditionally and last.
It reads back the manifest for verification.

The field `state: complete` means retained byte verification only.
It does not authenticate the producer, prove which frontend assets the browser loaded, or qualify boot/installation.
The script creates no public URL.

On upload, timeout or readback failure, the step fails. Partial chunks remain;
no cleanup or automatic retry occurs. An ambiguous final PUT may leave a valid
manifest even though the caller reports failure. Do not infer success or retry
writes from that outcome. Inspect the specific slot read-only first. Object
checks describe a verified snapshot, not an immutable access policy against
other writers.

## Reconstruct and verify

Use the manifest key and whole ISO SHA-256 from the successful workflow result.
You can also use the browser measurement that you saved independently.
Do not take the expected whole-file hash only from the remote manifest under test.
With the same existing R2 credentials configured in the environment:

```sh
python3 scripts/retain-browser-candidate.py \
  --restore-manifest browser-iso/candidates/RUN/ATTEMPT/yellowfin-gnome/s1/manifest.json \
  --expected-sha256 sha256:INDEPENDENT_ISO_HASH \
  --output candidate.iso
```

The script needs `boto3` and accepts only the candidate namespace.
It verifies each chunk and the whole ISO, and exclusively creates the local output.
It refuses an existing output. A failed reconstruction leaves a partial local
file and returns failure; do not boot that file or treat it as verified.

## Retain as a GitHub Actions artifact instead (no R2, no secrets)

Independent of the R2 path above, and the preferred route while the org
removes its dependency on R2 (tuna-os/tunaOS#3470):

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"retain_iso_artifact_days":"7"}
```

Off by default. The plan rejects an empty or multi-slug `only`, benchmark mode,
`keep_iso` and retention days outside 1-90. Any single named cell is allowed
(the R2 path stays Yellowfin GNOME only). No `R2_*` secret is read, and the
workflow permission stays `contents: read`.

After the browser build (and after the guest check, even if it failed),
`scripts/retain-iso-artifact.py split` verifies that the ISO on disk has the
sha256 and size the browser measurement recorded, cuts it into 2 GiB chunks
(`<slug>.iso.partNNNN`) and writes `manifest.json` with the sha256 of the whole ISO
and of every chunk, the measurement fields, producer run/attempt/SHA, and the
measurement's own label (`not-assessed`, or `diagnostic-unqualified` for a
build made with the test-only override). It never writes `qualified`.
Chunks upload uncompressed as `iso-<slug>-run<id>-a<attempt>`; the manifest is
also uploaded alone as `...-manifest` so the hash can be read without the ISO.
The local chunks are then deleted, the artifact is downloaded again and
`verify` re-checks every chunk and the reassembled ISO against the hash taken
from the browser measurement (not from the manifest under test).

Fetch and verify yourself, using a hash you saved independently:

```sh
gh run download RUN -R tuna-os/iso-builder -n iso-skipjack-gnome-runRUN-aATTEMPT -D dl
python3 scripts/retain-iso-artifact.py verify --dir dl \
  --expected-sha256 sha256:INDEPENDENT_ISO_HASH --output skipjack-gnome.iso
```

### Limits (sources, not measurements of this repo)

- `actions/upload-artifact` documents no per-artifact size cap; documented limits are
  500 artifacts per job and the account's artifact storage quota
  ([README, Limitations](https://github.com/actions/upload-artifact#limitations)).
  tuna-os/iso-builder is public (storage quota billing applies to private repos only),
  and the repository retention setting reads `days: 90, maximum_allowed_days: 90`
  (`gh api repos/tuna-os/iso-builder/actions/permissions/artifact-and-log-retention`).
- `retention-days` must be 1-90 and cannot exceed the repository setting. Expired
  artifacts are deleted by GitHub; nothing here has to clean up.
- A 6.16 GB artifact transfer with SHA verification was measured in tunaOS #3662; a
  run of this exact workflow at 5-7 GB has not been measured yet. Chunking keeps
  every file at 2 GiB, caps a bad-transfer blast radius to the hash that names the
  chunk, and stays far below 64 chunks (the script's ceiling; ISO ceiling 16 GiB).

## Provenance limits and tests

The local collector binds the measured bytes to the committed served tree and observed WASM/ISO.
It rejects replacement refs in Git, omissions from a mutable index, and external diffs that hide changes.
It also rejects hidden changes to tracked files, symlinks and byte mismatches.
Its GitHub context remains an unverified claim until an independent run/artifact
verifier authenticates it. Frontend delivery and installer identity remain open.

Install test dependencies with `python3 -m pip install pytest PyYAML`, then run
the unit and workflow-contract suite with `python3 -m pytest -q tests`.
Fixtures are tiny and storage is in memory. They test scope guards, atomic
conflicts, missing/ambiguous writes, remote corruption, reconstruction and failure preservation.
They make no live storage calls and prove no real ISO build or installation.
