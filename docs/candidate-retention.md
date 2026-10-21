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

Use the manifest key, manifest SHA-256, and whole ISO SHA-256 from the successful workflow result.
You can also use the browser measurement that you saved independently.
Do not take the expected whole-file hash only from the remote manifest under test.
With the same existing R2 credentials configured in the environment:

```sh
python3 scripts/retain-browser-candidate.py \
  --restore-manifest browser-iso/candidates/RUN/ATTEMPT/yellowfin-gnome/s1/manifest.json \
  --expected-sha256 sha256:INDEPENDENT_ISO_HASH \
  --expected-manifest-sha256 sha256:INDEPENDENT_MANIFEST_HASH \
  --output candidate.iso
```

The hash of the manifest binds the exact metadata bytes before output creation.
Without it, restoration remains a legacy diagnostic check; it cannot support
v2 evidence for retained media. The result reports `manifestHashChecked`.
Neither mode authenticates the producer.

The script needs `boto3` and accepts only the candidate namespace.
It verifies each chunk and the whole ISO, and exclusively creates the local output.
It refuses an existing output. A failed reconstruction leaves a partial local
file and returns failure; do not boot that file or treat it as verified.

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
