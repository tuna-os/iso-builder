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

This path does not depend on the R2 path above. Prefer it while the org removes
its use of R2 (tuna-os/tunaOS#3470). Dispatch it like this:

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"retain_iso_artifact_days":"7"}
```

The input is off by default. The plan rejects an empty `only`, more than one slug,
benchmark mode, `keep_iso`, and retention days outside 1 to 90. You can name any
one cell. The R2 path stays limited to Yellowfin GNOME. The workflow reads no `R2_*`
secret, and its permission stays `contents: read`.

The steps run after the browser build, and also after a failed guest check:

1. `scripts/retain-iso-artifact.py split` checks that the ISO on disk has the
   SHA-256 and size from the browser measurement. It stops if they differ.
2. It cuts the ISO into chunks of 2 GiB, named `<slug>.iso.partNNNN`.
3. It writes `manifest.json`. The manifest holds the SHA-256 of the whole ISO and
   of each chunk and the measurement fields. It also holds the run, the run
   number and the commit. The label of the measurement is in it too. The label is `not-assessed`, or
   `diagnostic-unqualified` for a build that used the test-only override. The
   script never writes `qualified`.
4. The workflow uploads the chunks without compression as
   `iso-<slug>-run<id>-a<attempt>`. It also uploads the manifest alone as
   `...-manifest`, so you can read the hash without the ISO.
5. The workflow deletes the local chunks and downloads the artifact again. Then
   `verify` checks each chunk and the joined ISO against the hash from the browser
   measurement. It does not use the hash in the manifest under test.

### Optional strict test of the exact round-tripped bytes

The bounded same-byte path is off by default and accepts only this dispatch:

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_iso_artifact":true,"diagnostic_unqualified":true,"strict_roundtrip_test":true,"retain_iso_artifact_days":"7"}
```

The job timeout is 360 minutes for this path. The capped build, artifact
transfer, input preparation, and guest test total 275 minutes. Setup and the
pinned harness checkout have 45 minutes of caps. Finalization has 35 minutes;
the job keeps 5 minutes for margin.

The workflow adds no cross-repository artifact credential and writes nothing to R2. It deletes the local ISO, downloads the artifact from this run, and checks each chunk and the full-file hash against the browser measurement. It restores the same bytes to a separate ISO file. It compares the manifest's repository, source SHA, run ID, try number, target, and measurements with this job. The upload action returns an artifact ID. The workflow records that ID in the binding sidecar before guest boot.

Before the workflow starts the strict harness at
`64da1ea1af6b19487ad9cea85213c41646e3ff7f`, it reads
`live-source.json` and `live-installer-info` from the ISO's live filesystem
payloads (squashfs, or the EROFS live root the browser engine writes). The
published overlay carries the installer identity; the engine completes
`live-source.json` at build time with the base and overlay manifest digests it
applied and the `engineDigest` the page measured over the exact `tbox.wasm`
bytes it instantiated, and refuses the build if any of them is missing or
disagrees with the overlay. The workflow compares source and overlay digests
with the browser's `engineBuildResult` and the engine digest with the
harness's independent `loadedWasm` measurement. The workflow uses the installer
identity from the media receipt. It passes the browser name and version, plus
same-runner memory and free-disk measurements, through `sudo`. It removes
`TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE` from the environment. If an identity is
missing or inconsistent, the workflow stops before guest execution.

The sidecar uses the diagnostic-unqualified label. The guest output directory is
`luks-verify-<slug>-diag`; the name stays short because the harness binds Unix
sockets inside it and `sun_path` holds 107 bytes. The recipe stops before guest
execution if `strict-plain-warm-serial.sock` there would exceed that. This
test does not authenticate the producer or frontend. It does not turn a failed
browser identity into a pass, qualify the target, publish an ISO, or change
catalog or download status. The sidecar records `baseAnnotationMatched` as
evidence; that value does not prove a match. This change has no hosted run.

Before upload, the finalizer renames each nested qualification receipt to a diagnostic name.
It uses `diagnostic-unqualified-evidence.json`, with a number if that name exists.
The finalizer writes `DIAGNOSTIC-UNQUALIFIED.txt` in the guest output directory.
The diagnostics artifact includes the renamed receipt and marker.
The strict path skips the separate `qual-*` evidence upload.

To fetch and check the ISO yourself, use a hash that you saved independently:

```sh
gh run download RUN -R tuna-os/iso-builder -n iso-skipjack-gnome-runRUN-aATTEMPT -D dl
python3 scripts/retain-iso-artifact.py verify --dir dl \
  --expected-sha256 sha256:INDEPENDENT_ISO_HASH --output skipjack-gnome.iso
```

### Limits

These limits come from documents, not from a run of this workflow:

- The `upload-artifact` README names no size limit for one artifact. It names 500
  artifacts for each job and the storage quota of the account.
- The repository is public. Its retention setting is 90 days at most.
  `gh api repos/tuna-os/iso-builder/actions/permissions/artifact-and-log-retention`
  shows it.
- `retention-days` must be from 1 to 90. GitHub deletes an artifact when it
  expires. Nothing here needs cleanup.
- The tunaOS#3662 run moved an artifact of 6.16 GB and checked its SHA. A run of
  this workflow at 5 to 7 GB has not happened yet.
- Chunks of 2 GiB keep each file small. A bad transfer names the chunk by its hash.
  The script allows 64 chunks and an ISO of 16 GiB at most.

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
