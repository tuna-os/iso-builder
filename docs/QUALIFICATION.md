# Browser qualification admission

Catalog availability and an ISO format check do not prove live-install parity.
A qualified target needs a strict receipt for its exact source, overlay,
installer and engine. The receipt must prove a live desktop and GUI installs
with the network disabled. It must cover plain and encrypted disks, then a
reboot from each installed disk alone.

The evidence needs the browser name, version and resource prerequisites.
Three cold samples do not measure cold and warm performance.

## Incomplete catalog provenance

Symptom: edition cards and Inspect claim `qualified` with no overlay identity
or browser prerequisites. At commit `622fc34`, 54 catalog rows had null overlay
digests and the strings `tacklebox-1.0` and `remora-1.0`.
The public catalog fetched on 2026-10-19 matched the source file.
Its SHA-256 was `2ca80ba998082eeed685521c6c0f630c7a0c5e061d302a1820e4e34d4903a691`.

The deploy job in [run 39104556492](https://github.com/tuna-os/iso-builder/actions/runs/39104556492)
succeeded. That run skipped full-matrix and did not prove installation.

Cause: the consumer checked the snapshot checksum, status enum and source
digest, then trusted the status. A digest-shaped identifier does not establish
a complete receipt. The app also embedded these claims as fallback data.

Fix: withdraw these claims from the web, native and embedded catalogs.
Keep all targets and publication records. The gate checks source, overlay and
base identities. It checks digests for the installer, engine and receipt.
It also checks the date, browser name and version, and positive memory and disk
values.

The app rejects metadata that is incomplete and keeps the local fallback.
That fallback exports the exact BuildRequest. The CI validator rejects the
incomplete claim.

This is **not cryptographic verification of a receipt**. It does not prove an
installation or that the inputs remain current. The producer must validate
the observed evidence and bind the receipt to inputs collected independently.
Only then can it publish a qualified status. This change qualifies no target.
Synthetic metadata exists only in UI fixtures, never as runtime evidence.

## Strict harness handoff

The pinned tunaOS harness at `e89bf562d7488242295bf02c228bbba4c509b388`
rejects `TBOX_E2E_IMAGE` in strict mode because it enables the generic CLI install
fallback. Pass it only to the upstream-reference LUKS path. Explicitly unset it
for strict GUI qualification. Keep the harness guard.

Issue #270 still needs these steps:

- Bind the browser output and producer inputs to the strict harness.
- Support isolated candidate builds before any public claim of qualification.
- Preserve each sample outside the output directory that Playwright clears.
- Measure transfers for paired cold and warm runs with unchanged inputs.
- Review the harness pin against the newer strict contract in
  [tunaOS #3431](https://github.com/tuna-os/tunaOS/pull/3431).

The current benchmark uses three cold profiles. It does not prove warm reuse.

A maintainer must review and approve deployment. A merge to main automatically
deploys the app and relay. Public download routes, R2 publication, retention and existing objects stay intact.

Admission timestamps use UTC whole seconds (`YYYY-MM-DDTHH:MM:SSZ`), as the
strict harness emits. Both consumers reject dates that are invalid and strings
without this format. Both trim browser names before the native checks.

The minimum gate also needs browser origin, a build receipt digest and the final
ISO digest. The producer must match these to a separate observation from a
trusted browser-build workflow and artifact. A self-asserted origin flag does
not prove that association. The current producer lacks this integration and
must keep targets unqualified. A native install result does not establish
browser origin. Placeholder browser names and versions cannot pass the gate.

## Browser build diagnostic measurements

The existing `@full` test writes a separate `build-measurements-*.json` file
beside its legacy evidence. The full diagnostics artifact includes this file;
the qualification-evidence validator does not consume it.

The record contains the SHA-256 and byte count of the saved ISO. If the test
retains a separate copy for later steps, it hashes that copy too and needs
an exact match. The file checks describe the observed snapshot; they do not
prevent later mutation or authenticate a published artifact.

A test-page observer clones the exact Response passed to native
`WebAssembly.instantiateStreaming`. It reads at most 64 MiB, hashes those bytes,
and needs exactly one call that loads `tbox.wasm` from the same origin.
The call must succeed without a redirect. Missing, failed or ambiguous observations prevent the record.
This records bytes supplied to `instantiateStreaming`, not an authenticated engine.

The observer exists only in the test page. It leaves the native result and
failure independent of the hash operation. Its memory and timing overhead
means these samples do not qualify performance.

Chromium product/version and user agent come from the same page's CDP session.
Stage durations use a monotonic clock and exclude navigation. The record has
kind `diagnostic-build-measurements`, with `qualification: not-assessed`.
Tiny fixtures test the observer and file checks without a multi-GB ISO build.
They do not establish a real browser build or installation result.

The engine pin now includes the operation-local result API at
`tacklebox/b2c917d7e896d49d095daefe6a812beb9d4398d6`. Its consumer validates the
observed result and saved byte count; see [browser build observations](browser-build-observations.md).
Producer and frontend identity remain missing. These diagnostic records are not
qualification receipts and change no catalog admission or download route.

The [integration proposal](browser-qualification-integration-plan.md) describes
the reviewed retention, provenance and strict-harness gaps. It authorizes no
build, publication or change to download routes.

## Diagnostic build of an unqualified target (test-only)

The browser gate (`catalogQualification` in `app/public/app.js`) refuses every
target that lacks complete qualification provenance, so a target cannot produce
its first qualification evidence through the gate. The `@full` spec can build one
named, catalog-unqualified target for diagnostics:

```sh
gh workflow run ci.yml -f run_full=true -f only=skipjack-gnome -f diagnostic_unqualified=true
```

- Off by default. Requires `only=` (the plan rejects an empty `only`, `keep_iso`
  and non-`run_full`). `ci.yml` sets `DIAGNOSTIC_ALLOW_UNQUALIFIED=1` and
  `DIAGNOSTIC_TARGET=<image>` only on the `@full` build step. The spec refuses
  unless `DIAGNOSTIC_TARGET` equals the image it builds.
- The deployed app never reads those variables. It honours only a frozen page
  global installed by Playwright `addInitScript` that names the exact image and
  platform; URL, storage and UI cannot install it. The page shows status
  `diagnostic-unqualified (<gate reason>)`, the request carries no
  `qualificationId`, and the gate itself is unchanged.
- Every evidence file records `qualification: "diagnostic-unqualified"` plus a
  `diagnosticUnqualified` block (label, image, platform, gate reason). These
  files are not qualification: they never carry `qualified`, and the R2 retention
  scripts, which require `not-assessed`, reject them.
- When the gate refuses a target, the `@full` cell now fails within seconds with
  the gate reason (also written to the job summary) instead of after the 5 minute
  inspect stall watchdog.
