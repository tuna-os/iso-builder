# Browser build observations

The browser checks for `tboxBuildIsoWithResult(opts, onChunk)`.
An older engine uses the numeric `tboxBuildIso` API.
Its `tboxCurrentOperation.buildResult` stays `null`.
`native/go.mod` pins the engine source; CI builds `tbox.wasm` from that pin
and pairs it with the compiler's `wasm_exec.js`.
The e2e and deployment jobs use that same artifact.
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
Its legacy `missingIdentity: ["producer", "frontend"]` field remains unchanged.
A WASM hash does not identify the frontend commit or authenticate its producer.
A config descriptor with `bytesVerified: false` does not prove consumed bytes.
An overlay with `baseAnnotationMatched: false` does not prove annotation linkage.

These records do not qualify boot, installation, hardware or performance.
Their filenames stay outside the qualification consumer globs.


## Post-close measured input envelope

The full-build test also writes
`browser-observed-input-<evidence-basename>.json` next to the legacy diagnostic.
This is an observation, not a v2 receipt or a policy.
The example shows the shape, not complete or usable observations:

```json
{
  "schemaVersion": 1,
  "kind": "browser-observed-input",
  "qualification": "not-assessed",
  "observed": {},
  "missingFields": [],
  "media": { "sha256": "sha256:...", "sizeBytes": 1 },
  "measurements": {}
}
```

`observed` contains only available fields from `BrowserObservedInput`.
The selection token combines the operation ID and `buildAttempt`.
`missingFields` lists each absent field.
`measurements.missingReasons` states why each gap remains.
The collector must reject a conversion if any required field is absent.

### Media and consumed request

The observer reopens the saved download after close and hashes its bytes.
It checks the handle, filename, size, mtime and ctime.
A retained copy must have the same hash.
The module hash comes from the same response that native WASM instantiation used.

The hook observes `JSON.stringify` inside the engine call.
The parser uses that returned string before it returns a Promise.
The observer hashes those UTF-8 bytes, not a later copy of the form or catalog.
It retains only hash, size and format under `measurements.buildRequest`.
Raw requests can contain secrets; the envelope never contains their text.

The hook preserves the native return value, Promise and thrown error.
Missing, duplicate, oversized or unsupported observations stay missing.
The completed operation must still match after each asynchronous measurement.
The observer checks the result again after the saved-file hash.

### Loaded frontend and engine facts

`frontendFiles` hashes public responses that the page loaded.
The observer does not read checkout files or fetch a URL again.
Only paths from the allowlist survive.
It excludes credentials, queries, fragments and raw network errors.
Failures use constant codes.

`runtimeShim` selects one loaded `wasm_exec.js` response.
`config` selects one loaded `builder-config-data.js` response.
Failed or ambiguous observations stay missing.
The script hash does not measure an unconsumed `builder-config.json`.

The validator retains facts from the engine for this operation:

| Fact | Boundary |
| --- | --- |
| Source manifests | Exact manifest and optional index digests; optional index architecture/variant; source-config descriptor and `bytesVerified`. |
| Source coordinates | Optional `registryEndpoint`, `repository`, `requestedReference`. The endpoint can be a proxy, not an origin assertion. Sensitive endpoints fail. |
| Config content | Optional OS/architecture/variant only with `bytesVerified: true`. No index or CPU substitution. |
| Applied overlay | Optional `baseDigest` must match the source digest before canonical `observed.overlay` exists. Application/linkage checks remain required. |
| Installer | Actual deployment app/ref/arch/commit must match the measured source stamp before canonical `deployed_frontend` exists. Stamp claims alone do not suffice. |
| Bundle/helper/recipe | Bundle claims remain claims, not canonical `bundleSha256`. A helper hash implies no VCS identity. `shippedRecipe` hashes a shipped file, not runtime consumption. |
| Engine | Actual `ReadBuildInfo` for tacklebox, not a pin. Canonical `loaded_engine` needs `cmd/tbwasm`, a full revision, `vcsModified: "false"`, the module hash and one shim hash. |

Older engines omit these optional facts.
Dirty, no-VCS or native-package engine metadata stays diagnostic.
This change does not alter an engine pin or create an engine artifact.

### Resources and producer context

The browser reports device memory.
It estimates storage from quota minus usage.
Elapsed time uses `performance.now`, from engine entry through close.
It includes the observer and save overhead.
Partial observations stay diagnostic.

`producerEnvironment` copies only an allowlist of `GITHUB_*` values.
The values for `runId` and `runAttempt` must be positive integers within the safe range.
It never copies secrets or token variables.
Environment values alone do not authenticate a producer or prove run success.

`executingSource` measures the checkout before navigation and after close.
Its hashes must match tracked `HEAD` blobs.
This covers the harness files, local dependencies and the workflow.
The tokens detect a file replacement, rewrites and changes to `HEAD`.
Dirty, untracked, symlinked or unavailable sources stay missing.

Checkout bytes alone do not identify the code that Node loaded.
Node asks V8 for that code through `Debugger.getScriptSource`.
`loadedSourceBefore` and `loadedSource` retain its hashes, sizes and relative paths.
They never retain source text, absolute paths, URLs or raw errors.
`require.cache` supplies filenames only.

The code must match `HEAD` exactly or its standard CommonJS wrapper.
The limits are 256 scripts, 8 MiB each and 64 MiB total.
A modified module still fails after someone restores its file on disk.
Source-map `sourcesContent` cannot replace the loaded bytes.
Transformed, ambiguous or unavailable code cannot use a disk-only fallback.

Every required module must match at both boundaries.
The checkout and loaded bytes must stay stable.
Valid CI context must also match the measured `HEAD`.
Both `GITHUB_SHA` and `GITHUB_WORKFLOW_SHA` must match that revision.
Only then can `observed.producer_run` name a candidate harness revision.

Otherwise the checkout stays diagnostic.
`producerRunMissingReason` records the failed binding.
Even a candidate does not authenticate a producer.
It does not establish run success, dispatch eligibility or the policy for `runAttempt`.

### Remaining canonical prerequisites

| Field | Required fact |
| --- | --- |
| `source_manifest` | Independently reviewed origin map and supplied CPU profile, plus observed OS/platform. Proxy coordinates and config bytes alone do not establish origin or CPU policy. |
| `recipe_sha256` | An agreed consumer and exact byte domain, then observation at that boundary. A shipped-file hash does not define that domain. |
| `config_sha256` | An agreed consumer and exact byte domain. Frontend scripts and source OCI config bytes remain distinct facts. |
| Conditional fields | Overlay linkage, installer deployment, clean engine metadata, loaded-code identity and CI context must satisfy the checks above. |

`build_request_sha256` and `resources` also stay missing without observations.
Requests, catalogs, pins and workflow claims do not fill those gaps.
This code changes no workflow pins, install drivers or retention policy.
It authorizes no build campaign.

## Tests

The suite checks the UTF-8 bytes at the request boundary.
It checks ambiguity, asynchronous changes and native Promise/error behavior.
A test in Chromium downloads a tiny file.
It joins those bytes to the loaded config and shim responses.

Tests use a temporary Git repository.
They check tracked blobs, hidden edits, replaced files, changed dependencies and invalid CI context.
One test loads a modified module, then restores the file before collection.
Another test supplies clean `sourcesContent` with different compiled code.
Neither can identify a clean harness revision.

Other fixtures check the config, overlay linkage, deployment metadata and engine build info.
They reject mismatched stamps, dirty/no-VCS metadata and hash-domain substitutions.
These tests do not prove installation, boot or producer authentication.

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
