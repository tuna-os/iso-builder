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
- Run the cold/warm pair protocol below and review its evidence.
- Review the harness pin against the newer strict contract in
  [tunaOS #3431](https://github.com/tuna-os/tunaOS/pull/3431).

The benchmark (`benchmark=true`) uses three cold profiles. It does not prove warm reuse.

A maintainer must review and approve deployment. A merge to main automatically
deploys the app and relay. Public download routes, R2 publication, retention and existing objects stay intact.

Admission timestamps use UTC whole seconds (`YYYY-MM-DDTHH:MM:SSZ`), as the
strict harness emits. Both consumers reject dates that are invalid and strings
without this format. Both trim browser names before the native checks.

The minimum gate also needs browser origin, a build receipt digest and the final
ISO digest. The producer must match these to a separate observation from a
trusted browser-build workflow and artifact. A self-asserted origin flag does
not prove that association. A native install result does not establish
browser origin. Placeholder browser names and versions cannot pass the gate.

That association now exists as a producer artifact. On `main`, a
`strict_roundtrip_test` run with `strict_install_mode=both` must pass both
strict legs on one retained ISO. It then emits a
`BrowserIsoQualificationReceipt/v1` and attests it with build provenance (see
the README). The receipt binds the ISO bytes, the producer run and artifact,
the harness revision and both harness results. The app catalog and its
admission gate are unchanged. They still keep every target unqualified until a
consumer verifies a receipt and publishes the result.

## Cold/warm pair protocol

The existing `ci.yml` route accepts `run_full=true`, `pair=true` and one
`only=<slug>`. A new six-build campaign needs explicit resource authorization
after source tests and review; this protocol is not that authorization.
The plan refuses `pair` with `benchmark`, `keep_iso`, `retain_candidate`,
`retain_iso_artifact` or `strict_roundtrip_test`. Pair mode is **build-only**:
no installation guest, retained ISO copy, registry fallback, or qualification
promotion. It does not change production admission or catalog authority.

`just full-build` runs six samples. Cold samples 1, 3 and 5 each wipe their
Chromium profile and keep it after the build. The next warm sample reopens
that exact profile and its OPFS cache after Chromium exits.
Cold must start with zero layers; warm must start with layers.
The Chromium test in `pair-protocol.spec.js` writes OPFS bytes, exits,
reopens warm and reads them. It then verifies a cold reset.

Pair mode freezes these values from the first sample:

- Digests of the source index, platform manifest and config.
- Digests of the overlay index, platform manifest and config.
- SHA-256 of the build request.
- Frontend revision and hashes of its source files.
- Engine module, `go.sum` and Playwright lock.
- Chromium version and user agent.
- SHA-256 of loaded WASM.
- Resources and limits.

A changed value aborts the campaign; it does not create a new baseline.
The diagnostic copy pins the overlay manifest. It does not invent a base
annotation. The engine must observe the applied overlay and
`baseAnnotationMatched=true`.

The resource declaration includes host memory, CPU count and cgroup limits
for memory, swap and CPU. It also records the filesystem's capacity/type,
Chromium arguments and viewport.

The recipe archives JSON and exit status outside Playwright's output directory.
It restores them on success or failure. Stop at the first failure.
Retain each failed try; never replace it or count it as a successful pair.

The CLI test uses six samples of JSON. It also tests a failure in sample two.
These tests check retention, not ISO builds.

An early error writes `failed-build-qual-evidence-<slug>-s<N>.json`.
The receipt records:

- The original error, with a bound on message length.
- The failed phase and elapsed time.
- Timings of completed phases.
- Available identities of fixed inputs.
- A partial snapshot from the observer.

The snapshot shows requests and observations that did not finish.
It does not wait for a stalled body or invent completed media.
The harness logs receipt and cleanup errors but rethrows the original error.
A failure before observer installation records that absence.

A test runs the full spec against the served frontend and checks its admission
refusal. Another test stalls a manifest over TCP and checks that a partial
snapshot returns without a wait for network completion.

Each `qual-evidence-<slug>-s<N>.json` records `run.pair`, `run.cacheMode`,
`phasesMs.wall` and `registryTransfers`. Events from the browser and its layer
worker provide request methods, status, Range headers, bytes and failures.
The observer also records manifest digests and metadata bytes.

A complete layer blob is a finished `GET` with status `200` and no Range.
It must have a positive byte count and must not be a manifest's config.
HEAD, redirects, `206` responses, zero-byte cache responses and failed
streams do not count.

Config bytes, range bytes, unknown sizes and in-flight requests stay separate.
Unknown sizes, incomplete requests or errors from the manifest observer
prevent successful pair proof.
Warm fails on any complete layer blob. Cold fails if the observer sees none.

The validator needs six successful outcomes and unchanged inputs across the
whole campaign. Each pair must use the same profile. It also needs complete
transfer observations and measurements of memory, storage and phases.
Media sizes must match the engine's output count.
The validator also needs independent SHA-256 values for media and WASM.

The summary `qual-evidence-<slug>-pairs.json` declares `diagnostic-unqualified`
or `not-assessed`. It does not qualify install, boot, parity or performance.

Wall time is navigation through validation of the saved ISO and Done, in milliseconds.
The report separates inspect/build/save durations, OPFS usage/quota and cache bytes.
ISO size and SHA-256 cover the saved file.
The harness samples WASM and JS heap hooks at phase boundaries and every
30 seconds. Hook MB values are estimates, not process RSS or exact peaks.

The request observer reads manifest bodies, never layer bodies.
Its elapsed duration includes the build and **is not** isolated overhead.

A test uses three pairs of batches over loopback TCP.
One batch has the observer off; the next has it on.
Each batch gets eight responses of 1 MiB from a public fixture.
It saves times and deltas in `observer-overhead.json`.
This measures the fixture, not ISO performance.

The WASM response clone/hash adds overhead that the test does not isolate.
Do not turn diagnostic timings into a performance qualification claim.

### Existing diagnostic campaign: retained proof boundary

[Run 41163294577, try 1](https://github.com/tuna-os/iso-builder/actions/runs/41163294577)
used main `b000857eae1bdb531ab1c25617f5f77789262b4a`, not frozen tacklebox
#423. Logs show success for six browser samples. Installation then failed
in the guest. Browser measurements do not need another guest.
Playwright cleared samples 1–5 before the uploads. The browser artifact
`13035668450` (`sha256:e546a78be5235aefd4bff45dfa9f327fab75a66eb839e9738a2dd9241aa9afd0`)
and diagnostics `13035244904`
(`sha256:80118443c1247c410758c9fccb6b4d47b78ee451c5d907e38d4f5b0e92a08296`)
both contain **only sample 6**, not three retained pairs.

The logs preserve this limited diagnostic comparison (encoded body bytes;
wall milliseconds rounded in the original log):

| Sample | Cache | Complete layers | Layer bytes | Blob bytes | Wall ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | cold | 67 | 3654967493 | 3654998970 | 1988510 |
| 2 | warm | 0 | 0 | 31474 | 2000879 |
| 3 | cold | 67 | 3654960908 | 3654992381 | 1987934 |
| 4 | warm | 0 | 0 | 31476 | 2006212 |
| 5 | cold | 67 | 3654995274 | 3655026749 | 2009127 |
| 6 | warm | 0 | 0 | 31471 | 1992329 |

Do not reconstruct missing per-sample media hashes, memory/storage or request
lists from those log rows. Retained sample 6 is diagnostic-unqualified:
ISO `11452401664` bytes,
`sha256:1db3810d4a69b0779cde8877a8c73e32c42fe39fc3cb22ad4a5016612b871ddd`;
WASM `14229140` bytes,
`sha256:dda64c75c91a2941160be0426f68ffcfffdcaa3362a7f98bd3c0bf5445747821`;
HeadlessChrome `156.0.8078.4`; sampled WASM `1113 MB`, JS heap `202 MB`;
OPFS `5492091620` usage / `16229509860` quota bytes; inspect `55.682 ms`,
build `1823444.904 ms`, save `168256.765 ms`. Its target digest field was stale
catalog data; engine-observed source was
`sha256:33f37e1ebea489b4de3104f8a937f9d91fd1362d928b4915c16d2c52b2fb9619`.
This is evidence of the warm cache, **not** a complete #4091 receipt.
Admission refused [run 41150669858](https://github.com/tuna-os/iso-builder/actions/runs/41150669858)
before build. That was not a cache failure.


## Browser build diagnostic measurements

The existing `@full` test writes a separate `build-measurements-*.json` file
beside its legacy evidence. The full diagnostics artifact includes this file.
The qualification-evidence validator reads it only for the pair summary's
build identities.

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

## Diagnostic build of an unqualified target (test only)

The browser gate (`catalogQualification` in `app/public/app.js`) refuses each
target that has incomplete qualification evidence. A target cannot make its first
evidence through the gate. The `@full` spec can build one named target for
diagnosis only:

```sh
gh workflow run ci.yml -f run_full=true -f only=skipjack-gnome -f diagnostic_unqualified=true
```

- The input is off by default. It needs `only=`. The plan rejects an empty
  `only`, `keep_iso`, and a run without `run_full`.
- `ci.yml` sets `DIAGNOSTIC_ALLOW_UNQUALIFIED=1` and `DIAGNOSTIC_TARGET=<image>`
  on the `@full` build step only. The spec stops if `DIAGNOSTIC_TARGET` is not the
  image it builds.
- The deployed app never reads these variables. It reads one page global that
  Playwright installs with `addInitScript`. The global names the exact image and
  platform. A URL, storage or the user interface cannot set it.
- The page shows the status `diagnostic-unqualified` and the gate reason. The
  request has no `qualificationId`. The gate code does not change.
- Each evidence file sets `qualification` to `diagnostic-unqualified`. It also
  holds a `diagnosticUnqualified` block with label, image, platform and gate
  reason. A diagnostic file is not a qualification and never says `qualified`.
  The scripts for R2 retention accept only `not-assessed`, so they reject it.
- The snapshot holds the registry digests from its generation date, and the
  engine enforces them. The first dispatch failed with
  `platformManifestDigest mismatch` (snapshot `01ae7e79`, live `5f2ac8b1`).
  A diagnostic build gets the live index, manifest and config digests of the
  named target from GHCR. It serves them to the page through a route. The
  committed snapshot does not change. The evidence records the old and new values
  in `diagnosticUnqualified.catalogPins`. If the build had no digests, the media
  would have no embedded offline layout.
- If the gate refuses a target, the `@full` cell now fails in seconds. It prints
  the gate reason and writes it to the job summary. Before, the cell waited for
  the inspect watchdog of five minutes.
