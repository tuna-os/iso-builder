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

The bounded same-byte path is off by default. It accepts two contexts for
`skipjack-gnome` only. The observed plain-install context is:

```json
{"run_full":true,"only":"skipjack-gnome","benchmark":false,"keep_iso":false,"retain_candidate":false,"pair":false,"retain_iso_artifact":true,"diagnostic_unqualified":false,"strict_roundtrip_test":true,"strict_install_mode":"plain","retain_iso_artifact_days":"7"}
```

The diagnostic context uses the same bounds with `strict_install_mode: "luks"`
and `diagnostic_unqualified: true`. The planner does not accept plain builds
with diagnostics, or LUKS builds without diagnostics. Neither context lets CI publish an ISO.

### Admission and qualification boundaries

CI can observe an image that the production catalog has not qualified.
The browser harness enables this route only with `TBOX_E2E_STRICT_OBSERVED=1`,
`TBOX_E2E_FULL=1`, and all the inputs above.
The frozen `__TBOX_STRICT_OBSERVED__` grant binds
`tuna-os/skipjack:gnome`, `linux/amd64`, install mode `plain`, and route
`retained-iso-roundtrip`. It is not a URL, UI, or browser-storage override and
cannot coexist with the diagnostic grant.

Observed builds retain `qualification: not-assessed`. The harness labels
their `strictObserved` evidence `observed, not assessed`. It records the image,
platform, and catalog pins, but supplies no `qualificationId`. The browser
resolves the descriptor for the exact architecture and variant. It records
the bytes it used. These observations do not prove qualification.

Diagnostic builds retain `qualification: diagnostic-unqualified`. Their label
states that CI used a diagnostic override. The production catalog keeps its
qualification guards. If CI retains an artifact or a guest test passes for one
mode, that result does not qualify an observed or diagnostic build.

The job timeout is 360 minutes for this path. The capped build, artifact
transfer, input preparation, and guest test total 275 minutes. Each setup step
has its own cap. The 360-minute limit also includes finalization and cleanup.

### Runner preparation

[Run 41249440653](https://github.com/tuna-os/iso-builder/actions/runs/41249440653)
stopped before the browser build. The step that used apt to install `just`
reached its 20-minute cap with no output. The next step reported
`just: command not found`. No ISO or guest receipt exists for that try.

The full job now uses the existing action `extractions/setup-just`, pinned at
`53165ef7e734c5c07cb06b3c8e7b647c5aa16db3`. It does not use apt to install
`just`. The job uses the x64 Ubuntu 24.04 runner and sets
`PREINSTALLED_BROWSER_DEPS=true`. The recipe accepts that flag only in this
GitHub Actions context.

The recipe installs the exact Chromium that the Playwright lockfile selects.
On a cache hit, it uses those cached bytes. It must launch and close Chromium
with the libraries on the runner in both cases. A missing browser or library
fails the step; the recipe does not ignore the error or try another source.
Other contexts still install the system dependencies. The build and guest
windows do not change.


The workflow adds no cross-repository artifact credential and writes nothing to R2. It deletes the local ISO, downloads the artifact from this run, and checks each chunk and the full-file hash against the browser measurement. It restores the same bytes to a separate ISO file. It compares the manifest's repository, source SHA, run ID, try number, target, and measurements with this job. The upload action returns an artifact ID. The workflow records that ID in the binding sidecar before guest boot.

Before guest execution, the workflow reads `live-source.json` and
`live-installer-info` from the ISO payloads. These use SquashFS or the EROFS live
root that the browser engine writes. The strict harness uses commit
`062e3d6da935d33b03f29e1ef1086ab6b3cf2edf`. It cross-checks a fragmented
welcome heading against one exact, original-pixel OCR crop and the complete
Install action; it does not relax confidence, phase, geometry, or duplicate guards.

The published overlay carries the installer identity. At build time, the engine
completes `live-source.json` with the base and overlay manifest digests it applied.
It also records `engineDigest` from the page's measurement of the exact
`tbox.wasm` bytes it instantiated. The engine refuses the build if any identity
is missing or disagrees with the overlay.

The workflow compares source and overlay digests with the browser's
`engineBuildResult`. It compares the engine digest with the harness's independent
`loadedWasm` measurement. The workflow uses the installer identity from the media
receipt. It passes the browser name and version, plus the memory and free disk
that CI measured, to the guest harness.

The plain leg uses `sudo`. The diagnostic leg uses an unprivileged service.
Neither path forwards `TBOX_E2E_IMAGE` or
`FISHERMAN_OVERRIDE`. If an identity is missing or inconsistent, the workflow
stops before guest execution.

The sidecar preserves `not-assessed` for the observed plain context and
`diagnostic-unqualified` for the diagnostic LUKS context. The guest output directory is
`luks-verify-<slug>-obs` for plain and `luks-verify-<slug>-diag` for LUKS. The harness creates Unix sockets inside this short
directory; `sun_path` holds 107 bytes. The recipe stops before guest execution if
`strict-plain-warm-serial.sock` there would exceed that limit.

### Isolated LUKS diagnostics

[Run 41249448336](https://github.com/tuna-os/iso-builder/actions/runs/41249448336)
built and retained an ISO. It checked the downloaded bytes and the binding to
the same run. The strict harness then returned 77 before it started a VM:
`TUNAOS_INSTALLED_BOOT_DIAGNOSTIC=1` needs a real supervisor socket.
That run proves no install or detached boot.

The browser adapter imports `ContainedProcess` and `OwnedQemu` from the
immutable harness above. These existing classes own each service, its signals,
and cleanup. The adapter starts the real socket and proxy for that owner.
It does not create a dummy socket or run the native producer's CLI.

The adapter checks the same-run binding and ISO hash again. It keeps the browser
identity, the diagnostic label, and the full 900-second window for the harness.
The service does not retain raw stdout or stderr. The adapter stops all owned
services on every exit. A cleanup failure cannot turn a failure into a pass.

The receipt reports the primary exit and the result of cleanup. It never
qualifies an image.


This test does not authenticate the producer or frontend. It does not turn a
failed browser identity into a pass, qualify the target, publish an ISO, or change
catalog or download status. The sidecar records `baseAnnotationMatched` as
evidence; that value does not prove a match. These identities alone do not prove a guest boot.

Before upload, the diagnostic-context finalizer renames each nested qualification
receipt to `diagnostic-unqualified-evidence.json`, with a number if that name
exists, and writes `DIAGNOSTIC-UNQUALIFIED.txt` in the guest output directory.
Observed evidence must retain its `not-assessed` label. It must not claim that
CI used a diagnostic override or proved full qualification.
The diagnostics artifact includes the renamed receipt and marker.
The strict path skips the separate `qual-*` evidence upload.

To fetch and check the ISO yourself, use a hash that you saved independently:

```sh
gh run download RUN -R tuna-os/iso-builder -n iso-skipjack-gnome-runRUN-aATTEMPT -D dl
python3 scripts/retain-iso-artifact.py verify --dir dl --diagnostic-unqualified true \
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
