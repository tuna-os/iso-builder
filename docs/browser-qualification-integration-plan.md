# Browser ISO qualification integration proposal

This document reviews how browser evidence must connect to installation qualification. The optional `strict_roundtrip_test` path in `.github/workflows/ci.yml` was dispatched once on 2026-10-27 as run [40538072100](https://github.com/actions/runs/40538072100). It built and hash-verified a Skipjack/GNOME ISO, then failed receipt preparation before guest execution. This remains diagnostic only; it does not qualify the ISO, authorize publication, deploy the builder, or change download routing.

## Reviewed sources

- iso-builder `f6a0bfa`: `.github/workflows/ci.yml`,
  `e2e/tests/builder.spec.js`, `e2e/tests/build-measurements.js`.
- tacklebox pin: `b2c917d7e896d49d095daefe6a812beb9d4398d6`.
- tunaOS draft #3431 `ed1d226a0aeff09f186a6a129a8ce9f029a18385`:
  `scripts/iso-e2e.sh`, `.github/workflows/iso-builder-parity.yml`.

These revisions record the inspection, not live status. Re-review the harness and
frontend revisions that you select for a run.

## Current blockers

1. Run [40538072100](https://github.com/actions/runs/40538072100) built and hash-verified a Skipjack/GNOME ISO, then failed receipt preparation with `ISO has no embedded etc/tunaos/live-source.json receipt`. No guest step ran. Do not retry these unchanged bytes.
2. The retained artifact lacks per-payload `unsquashfs` format, path, and stderr details. The current local helper change writes bounded details into the always-uploaded diagnostics artifact; it has not yet been run on a hosted builder.
3. Browser measurements report an applied overlay with `baseAnnotationMatched=false`, and the observed source manifest differs from the pre-build catalog digest. This is not a root-cause finding. Require a same-base overlay with a valid media receipt and matching current source identity before another build.
4. Producer/frontend authentication and a genuine media-bound installer frontend identity remain missing. The diagnostic artifact cannot create a trusted browser receipt.
5. No browser-built bytes have passed strict plain/LUKS installation and media-detached cold/warm boots. Three paired cold/warm builds and zero-warm-layer-transfer evidence are also absent; qualification and performance claims remain blocked.

## Observed diagnostic dispatch

Workflow: `tuna-os/iso-builder/.github/workflows/ci.yml`, main `4a0e1c34be84e87ce400414ed9f0bc2f1c309ce1`.

Run [40538072100](https://github.com/actions/runs/40538072100) selected one x86 target with these inputs:

```json
{"run_full":true,"only":"skipjack-gnome","retain_iso_artifact":true,"strict_roundtrip_test":true,"diagnostic_unqualified":true,"benchmark":false,"keep_iso":false,"retain_candidate":false,"retain_iso_artifact_days":"7"}
```

It built a 9,446,709,248-byte ISO (`sha256:e03ad6c8be6431ae35517c2cb6ee010d725fcfec25ad32e8b06f0d82971e8891`) and verified the GitHub artifact round-trip. ISO artifact ID `12751782226` expired 2026-11-03. Receipt preparation failed before guest execution; no install, reboot, R2 write, or qualification resulted.

## Integration stages

[Candidate retention](candidate-retention.md) documents the implemented GitHub-artifact path and the separate R2 candidate path. Producer/frontend authentication and strict qualification remain unverified.

### A. Retain and bind one diagnostic candidate

The current `retain_iso_artifact=true` path uses run- and attempt-bound GitHub artifacts, splits the ISO into 2 GiB chunks, verifies each chunk and the whole file against the browser measurement, downloads the artifact again, and verifies the reconstructed bytes. Run 40538072100 used seven-day retention and did not set `retain_candidate` or `keep_iso`.

The retained manifest binds the browser measurement, source SHA, run ID and attempt. It does not authenticate the producer or frontend, so it remains `diagnostic-unqualified`. Receipt extraction now writes bounded per-payload format/path/error diagnostics into the always-uploaded diagnostics artifact. Missing or inconsistent receipts remain a hard failure before the strict guest starts.

Never retain private keys for SSH, swtpm state, or installed qcow2 disks. Preserve the original failure status and keep diagnostic output separate from qualification evidence.

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
The reviewed candidate `ed1d226a` does not authorize an automatic pin change.
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

## R2 candidate retention remains separate

Run 40538072100 set `retain_candidate=false` and `keep_iso=false`; it wrote no R2 object. It used the distinct `retain_iso_artifact=true` path and a seven-day GitHub Actions artifact (ID `12751782226`, 9,446,709,248 bytes, expiry 2026-11-03). The run failed before guest execution and does not qualify the ISO.

The legacy R2 candidate path still needs its own review of access, quota, overwrite protection, and lifecycle policy. See [candidate-retention.md](candidate-retention.md). This run changed no R2 policy or object and authorized no cleanup.

## Local producer-observation regression proposal

`scripts/collect-candidate-provenance.py` has no CI integration.
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
A browser response observer must bind the served frontend bytes to those that the browser loaded.
The installed-installer frontend needs its own identity.
This local snapshot does not complete the trusted producer/consumer protocol.
