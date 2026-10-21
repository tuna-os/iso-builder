# Browser ISO qualification integration proposal

This is a review proposal. It provides no qualification evidence or authorization
to run, publish, deploy, or change download routes.

## Reviewed sources

- iso-builder `f6a0bfa`: `.github/workflows/ci.yml`,
  `e2e/tests/builder.spec.js`, `e2e/tests/build-measurements.js`.
- tacklebox pin: `b2c917d7e896d49d095daefe6a812beb9d4398d6`.
- tunaOS draft #3431 `ce442239dc9ee12fc1de324d8f641bc8f319cad7`:
  `scripts/iso-e2e.sh`, `.github/workflows/iso-builder-parity.yml`.

These revisions record the inspection, not live status. Re-review the harness and
frontend revisions that you select for a run.

## Current blockers

1. The GitHub connector supports reads and failed-job reruns, but no workflow dispatch.
   A rerun cannot supply new dispatch inputs. Do not substitute a push, rerun,
   or production deployment for dispatch.
2. `keep_iso=true` publishes to R2 only after guest verification succeeds.
   Failure discards the runner-local candidate. For parity, named artifacts in GitHub must contain ISO files and experience manifests.
   The full workflow creates neither artifact.
3. The full workflow does not supply immutable identities for the overlay and engine.
   It also lacks the target variant/flavor and measured browser version that the strict harness needs.
   A new pin for checkout cannot qualify it alone.
4. The diagnostic record does not identify the producer or frontend.
   An ISO hash, a hash of loaded WASM and engine observations do not fill those gaps.
   The legacy `qual-evidence` file uses catalog facts. It is not an authenticated browser receipt.

## Exact existing dispatch shape

Workflow: `tuna-os/iso-builder/.github/workflows/ci.yml`.
These inputs select one flagship target on x86:

```json
{"run_full":true,"only":"yellowfin-gnome","benchmark":false,"keep_iso":false}
```

This selects `tuna-os/yellowfin:gnome`, `linux/amd64/v2`.
It does not pin the mutable image tags or preserve a failed candidate.
The valid input `keep_iso=true` publishes to R2 after successful guest verification.
It does not provide failure-safe retention. Do not describe it as a retention-only switch.

Do not leave `only` blank: that selects all eleven editions.
Upstream reference cells use `qualify=false`. They prove no offline GUI parity for
TunaOS and qualify no TunaOS target. The input `benchmark=true` creates three cold
profiles, not a cold/warm pair. This review dispatched no workflow.

## Integration stages

[Candidate retention](candidate-retention.md) describes the opt-in draft for bounded retention.
The producer and strict qualification stages below remain proposals.

### A. Preserve and bind a single candidate

Keep candidate retention opt-in, false by default and independent of `keep_iso`.
Review the storage destination, access, quota and expiry before use.
This repository does not store multi-GB ISOs in Actions artifacts.
Do not silently switch to artifacts or move the R2 publisher before the gate.
Do not write release paths, latest pointers, or existing object keys.

Use an approved destination and a unique key for the run ID, `run-attempt`, edition and sample.
Refuse overwrite. Preserve the exact bytes exported from the browser even after a failure in strict qualification.
Hash before and after retention. Independently verify the remote artifact identity and bind it to the receipt.
Equal R2 sizes do not verify checksums.

Never retain private keys for SSH, swtpm state, or installed qcow2 disks.

Preserve diagnostics outside `e2e/test-results/` before another Playwright invocation clears it.
Finalize retention and diagnostics on failure and success; preserve the original failure status.
A format failure may retain a candidate with an explicit failure label.
It must not create a build receipt.

### B. Authenticate the producer and frontend

Use trusted workflow context to record the repository and the immutable SHA of the frontend checkout.
Also record the workflow path/revision, run ID, `run-attempt`, job, target and candidate artifact identity.
Hash the exact assets served for the frontend and the compiler-matched WASM shim.
Record the WASM measurement from inside the page.
Bind these values to the saved ISO and operation-local BuildResult.

Keep separate identities for the builder UI and the GUI installer in the installed system.
Measure the installer's frontend from the bundled image or Flatpak commit.
The hash of the backend executable for fisherman cannot replace that identity.
A checkout SHA alone does not prove which bytes the browser loaded.

A collector must validate these observations and authenticate the producer before it computes a browser-build receipt.
Do not use catalog facts, requests, mutable tags or arbitrary environment variables to supply missing observations.
Keep `qualification: not-assessed` until this integration exists and succeeds.

### C. Run strict qualification on those same bytes

Review and pin the complete harness tree, including helper scripts, to an immutable commit.
The reviewed candidate `ce442239` does not authorize an automatic pin change.
Use disposable VM disks only, under the dedicated output directory.
Rehash the retained ISO immediately before boot. Its hash must match the expected value.

Pass the verified values explicitly through sudo, which otherwise sanitizes the caller environment:

- `VARIANT=yellowfin`, `FLAVOR=gnome`.
- `TUNAOS_QUAL_PLATFORM=linux/amd64/v2`, CPU baseline `v2`, and the measured scope of the VM.
  A QEMU result must never imply physical hardware support.
- `TUNAOS_QUAL_SOURCE_DIGEST`, `TUNAOS_QUAL_OVERLAY_DIGEST`,
  `TUNAOS_QUAL_INSTALLER_DIGEST`, `TUNAOS_QUAL_ENGINE_DIGEST`, and
  `TUNAOS_QUAL_MEDIA_DIGEST` from verified provenance/bytes.
- `TUNAOS_QUAL_BROWSER_NAME`, `TUNAOS_QUAL_BROWSER_VERSION`,
  `TUNAOS_QUAL_BROWSER_MEMORY_GIB`, `TUNAOS_QUAL_BROWSER_FREE_DISK_GIB`
  from the actual browser host/session, not the later VM runner.

Invoke `scripts/iso-e2e.sh <candidate> --strict-offline-gui --output <isolated-dir>`
with `TBOX_E2E_IMAGE` and `FISHERMAN_OVERRIDE` absent.
The strict switch alone needs both plain and encrypted installs.
Keep guest `restrict=on`, the GUI walkthrough, ISO-detached installed boots, and source digest/targetImgref checks.
Do not use the generic CLI fallback for bootc.
Do not inject OCI data from the host or skip assertions.

Review budgets and dependencies. The old guest cap of 25 minutes does not prove
that two strict installs and cold/warm installed boots will fit.
The parity workflow uses a 90-minute job.
It includes OCR/SSH/image tools absent from the old full workflow.
Measure each bounded phase before you set new caps.
Do not increase budgets to hide stalls or missing prerequisites.

### D. Join evidence before qualification

Get strict evidence for both modes and bind the same ISO to the authenticated browser receipt.
Compare with a CI-built counterpart that has equal immutable inputs for source, overlay, installer and engine.
Media digests may differ, but each must match its own file.
The reusable parity workflow uses an x86 runner.
ARM qualification needs separate review of runner support.

Qualification needs successful checks for the producer, browser, live/GUI sessions,
plain/encrypted installs and installed boots.
Keep status, R2 cutover and download routes unchanged until the full freshness/admission policy accepts the receipt.

Measure cold/warm transfers separately. Keep one browser profile with identical immutable inputs.
Prove that the warm build transfers no complete layers.
Three fresh profiles or warm boots of the installed system do not prove this.

## Regression checks for implementation

- Fail before a multi-GB build for an invalid edition, missing immutable inputs,
  unavailable retention destination, or missing strict-harness dependencies.
- Reject admission for a mismatch in saved/retained ISO bytes, frontend identity, or `run-attempt`.
  Also reject missing producer/installer identity and replayed receipts.
- A strict failure must preserve the authorized candidate bytes and diagnostics.
  It must never publish release media or create a qualified receipt.
- Fail on plain-only or encrypted-only coverage, injected payloads, or guest egress.
  Also fail on an attached ISO at installed boot, a wrong source digest, or skipped GUI assertions.
- Fail warm reuse if the profile changes or any complete layer transfers.
- Unit tests must not write to storage, dispatch workflows, publish claims, or change routes.
  Use tiny synthetic files; these provide no boot evidence.

## Bounded retention consent proposal

Source inspection found only references to the secret-backed bucket and endpoint.
It did not verify the bucket name, public access, quota, or account-level lifecycle policy.
The existing writer uses `browser-iso/<run-id>/<slug>.iso`.
The reviewed tunaOS `prune-r2.yml` expires `live-isos/` after 14 days and
`screenshots/` after 60 days, but does not expire `browser-iso/`.
Verify access before you describe it as private or public.

The proposed consent is for one candidate for Yellowfin GNOME in the existing R2 bucket.
The caps are 10 GiB for the ISO and 1 MiB for provenance.
Use `browser-iso/candidates/<run-id>/<run-attempt>/yellowfin-gnome/s1/`.
Use bounded chunks with conditional writes and a final manifest that combines provenance.
No overwrites, latest pointers, release links, or access changes.

This proposed cap is not a measured ISO size. Fail without upload if the candidate exceeds it.
The scope excludes other candidates and repeated uploads.

Seven days is a proposed retention period; the existing code/tools cannot enforce or promise expiry.
Without separately approved and reviewed cleanup, objects may remain stored and incur charges until removal.
Do not add an account lifecycle rule or delete objects under this proposal.
[Candidate retention](candidate-retention.md) describes the opt-in implementation; no storage writes have occurred.

## Local producer-observation regression proposal

The step for opt-in retention calls `scripts/collect-candidate-provenance.py`.
It validates the manual-run context and compares the checkout SHA with the claimed workflow/run SHA.
It hashes the tracked frontend files, workflow and generated WASM/shim from the served tree.
It rejects changes to tracked files, unexpected untracked files, symlinks, empty files and concurrent file changes.
It independently hashes the candidate ISO and joins it to the browser's ISO and loaded-WASM observations.

Run it on the trusted producer host with the retained ISO and browser diagnostic JSON.
The existing GitHub job supplies its context fields:

```sh
python3 scripts/collect-candidate-provenance.py \
  --root "$GITHUB_WORKSPACE" --iso "$CANDIDATE_ISO" \
  --measurements "$BROWSER_MEASUREMENTS" > candidate-producer-observations.json
```

The output does not trust environment variables as authentication.
It keeps `qualification: not-assessed` and `authentication: not-verified`.
Frontend delivery and the remote artifact association remain unverified.
It emits no receipt digest and fills no identity gaps.

An external verifier must check the run/job/artifact.
The [response proposal for the frontend](browser-frontend-observation.md) compares
the loaded bytes with served files. Its page-only observer does not cover worker targets.
The full build must not use it until worker coverage is complete.
The installed-installer frontend needs its own identity.
This local snapshot does not complete the trusted producer/consumer protocol.
