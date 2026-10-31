# Browser build observations

The browser checks for `tboxBuildIsoWithResult(opts, onChunk)`.
An older engine uses the numeric `tboxBuildIso` API.
Its `tboxCurrentOperation.buildResult` stays `null`.
The engine pin in `native/go.mod` selects tacklebox commit
`b2c917d7e896d49d095daefe6a812beb9d4398d6` (the merged result API).
CI builds `tbox.wasm` from that commit and pairs it with the compiler's
`wasm_exec.js`; the e2e and deployment jobs use that same artifact.
Keep generated binaries out of this repository.

The consumer calls the result API once.
An error does not start a second build through the numeric API.
The consumer checks the schema and the count of bytes against successful writes.
The counts must be equal, positive safe integers.
It copies only known fields from the result.
It never fills gaps from a request or catalog.

## Completion boundary

The result stays private until `finishIsoSink` succeeds.
Then `tboxCurrentOperation.buildResult` holds a frozen copy.
The separate `outputDelivery` field describes the output:

- `{ "kind": "picker", "status": "stream-closed" }`: the selected file has a
  closed stream.
- `{ "kind": "download", "status": "initiated" }`: the browser starts a download
  from the file in OPFS. This does not prove that the file reached disk.

A cancelled export or an error in its write or close causes failure.
The app shows no `Done` status and exposes no result.
If the export picker is unavailable, the browser can start a download.
For example, the browser can lose transient activation after a long build.
This fallback records only `initiated`.
A cancelled initial picker also leaves no result.

A new build or inspection clears the old result and delivery state.
A change to the form does the same.
A failure or accepted engine reset also clears them.
The app rejects an obsolete result if the form changes before completion.
DDI builds do not create OCI observations.

Reset preserves the engine's return contract.
A successful `tboxReset` returns synchronous `null`.
The async API returns a Promise.
The app hides a completed result until the async reset ends.

The producer rejects an overlap with `tacklebox operation already in progress`.
That exact error changes no engine state and does not invalidate an active build.
All other reset errors invalidate the result, including a failure in cleanup.
The app waits for reset outcomes before it exposes a build result.

## Diagnostic collector

The full-build test keeps its qualification evidence separate.
The `build-measurements-*.json` file contains diagnostic measurements.
Its `engineBuildResult` contains the result or `null` for an older engine.
The collector needs these checks:

1. It captures the operation ID and a unique token for each build.
2. It hashes the WASM response used for successful native instantiation.
3. It hashes the file saved from the actual download.
   It checks file identity, size and changes to the file.
4. It checks that the engine's count of bytes equals the saved file's size.
5. It checks that the same completed build and result still apply.

The record stays `kind: diagnostic-build-measurements` and
`qualification: not-assessed`.
The field `missingIdentity: ["producer", "frontend"]` records the gaps.
A WASM hash does not identify the frontend commit or authenticate its producer.
A config descriptor with `bytesVerified: false` does not prove consumed bytes.
An overlay with `baseAnnotationMatched: false` does not prove annotation linkage.

These records do not qualify boot, installation, hardware or performance.
Their filenames stay outside the qualification consumer globs.

## Layer cache integrity

The cache checks each layer before it serves the bytes.
Each SHA-256 instance has a buffer for its schedule.
It uses the same buffer for each block.
Separate instances do not share mutable scratch.
This does not skip verification or hold a whole layer in memory.

## Experimental build measurements

On 2026-10-28, cold Chromium builds used the same image and overlay inputs.
The table shows the full build phase, not the shorter UI timer.
Save time is separate.

| Local candidate | Build phase |
|---|---:|
| Original | 20m 18.7s |
| Hash scratch reuse and buffered writes, latest control | 13m 21.0s |
| Same changes with lazy arena reopen | 9m 05.2s |

One original, two hash/buffer runs and one arena run were made.
The latest pair ran the arena candidate first, then the control.
The arena change cut this pair's build time by 31.94%.
The combined change cut time by 55.27% against the earlier original.
We used two pairs for that comparison.
These are measurements, not qualification or a speed guarantee.

All outputs had 9,447,305,216 bytes.
The inventory covered 78 outer files, 7 EFI files and 67 OCI blobs.
Only timestamps differed in the latest pair.
Browser storage use after the build was about 1.85 GB lower.
This is not a peak storage measurement.

The engine base was `5cc970f316615937c9caa5b7b9244381992cf0b1`.
The browser base was `8822b23cb027a7edb89ab7d79651eca9b4b8e2e8`.
The image manifest was
`sha256:71db4be3c4ddd827b8c89c7de191f5f0d99551815b886503de2c5b093af4b767`.
The overlay manifest was
`sha256:c86293fb3e9d65a91261cf52fe34bde9e9f0aa684046eaf03e022eb3688fd328`.
The arena WASM was
`sha256:0531cb4704c680be71709dfaac59ffbb94c71bea37ad3993a1a7f871efef44e3`.

These measurements include engine changes and reuse of the buffer for each hash.
The cache change alone does not include the engine changes.
The engine pin, production builds and deployment stay unchanged here.
We did not check Firefox, Safari, boot or encrypted installation.

## Tests

`e2e/tests/build-result.spec.js` checks the schema, counts and browser lifecycle.
`build-result-vm.spec.js` runs the real app functions with small test fixtures.
It does not need a browser.
`build-measurements.spec.js` checks byte measurements and the diagnostic join.
These fixtures cannot boot.

`observed-engine-browser.spec.js` loads the production WASM artifact in Chromium.
It serves a small OCI fixture through a test route and uses real OPFS.
It checks observed digests, saved byte counts, busy reset rejection, failed
and cancelled sinks, recovery, and reset cleanup. The fixture has fake kernel,
initramfs and EFI files. A successful test does not prove boot or installation.
The PR e2e job runs this test without the `@full` filter.

A full candidate needs a separate workflow dispatch with `run_full: true`.
The `only` input selects an edition. `keep_iso: true` uploads the ISO to R2
only after the guest test succeeds. If that guest test fails, the workflow
does not retain the ISO for a later test. The guest harness still uses the
existing pin.

See [candidate retention](candidate-retention.md) for the opt-in path to retain diagnostics.
Strict qualification still needs separate provenance and harness integration.

Run the focused suite from `e2e` with the installed Playwright dependency:

```sh
npx playwright test build-result.spec.js build-result-vm.spec.js build-measurements.spec.js
```

Without a browser, run the smaller set:

```sh
npx playwright test build-result.spec.js build-result-vm.spec.js build-measurements.spec.js \
  --grep-invert 'browser result lifecycle|native WASM diagnostic observation'
```

The VM tests supplement the browser tests.
They do not replace Chromium, engine integration or full-image qualification.
