# Browser frontend response checks

The checks record bytes from responses. They do not qualify an ISO.

This test-only proposal starts a host response observer before navigation.
It records the document, scripts, styles and WASM that the browser receives.
It reads response bodies through its own CDP session and hashes them outside
the page. It does not use Playwright's body reader, which can refetch a script.

The observer disables the browser HTTP cache and bypasses service workers.
It rejects redirects, failed requests and cache use for frontend resources.
Registry data is outside this frontend check.

The server must use a literal loopback address and send a positive
`Content-Length`. Each response is at most 64 MiB. The total is at most
96 MiB across 64 responses. Body reads are serial.
The body reader can buffer bytes before it returns them.

It rejects data above these limits. It cannot cap memory when a server sends
a false length. Use the static server from the reviewed workflow.

The full build does not call this observer yet.
Worker targets need their own controlled session before they load code.
By default, the observer rejects each worker.

An experiment uses public CDP messages for workers created directly by the page.
It binds the initial script to its target token and reads bodies on that session.
It rejects nested workers, missing initial requests and early detachment.
Its coverage is `page-and-direct-dedicated-workers-experimental`.
The collector rejects that coverage until a real fixture for Chromium passes in CI.
Mock tests alone do not prove that Chromium retains those initial bytes.

A future full-build caller must finish the observer after the saved ISO has a
hash, then check that the same build operation is still complete.
The diagnostic record can carry the response observations and engine result.

The retention collector compares the loaded bytes with the served files.
It needs the root document, `app.js`, `build-result.js`, `layercache.js`,
`wasm_exec.js` and `tbox.wasm`.
It checks other observed frontend files too.
It makes no claim about files that the browser did not load.
Tracked files must match the immutable checkout. The generated WASM and shim
remain separate byte identities.

`loadedFrontendBinding.status` can report
`observed-bytes-match-served-tree`. This is a byte comparison.
The producer remains unauthenticated. The ISO remains `not-assessed`.
The collector emits no qualification receipt.
Old diagnostic records without response observations remain readable, with
`loadedFrontendBinding: null`.

## Active build duration

The page records `buildTiming` only after the output closes and the operation
checks succeed. It binds the timing to the operation ID and build try.
The phases include initrd preparation, engine setup and current inspection,
then build, write and close. Their sum excludes the file-picker wait.
It also excludes an earlier UI inspection when the build reuses that work;
`inspectionReused` records this case. A retry starts new phase counters.

This is active work for the current build. It is not a cold-build benchmark.
Failure, cancellation, reset or a changed operation clears the timing.
The record does not construct a v2 receipt or qualify the ISO.

## Source origin binding

New engine fields retain the repository, request reference and registry endpoint
from the resolve operation. The endpoint can be a proxy; it does not prove origin.
The validator preserves all three fields together, or accepts old results with
none of them. Missing coordinates cause the source binder to reject the input.

The binder compares coordinates from the engine with the actual operation and an
independently supplied map from origin to proxy. It combines that declared origin
with the consumed repository and observed child digest. The result must equal
the expected immutable reference. An index digest stays separate.
The result separates `engineObserved` from `declaredPolicy` and remains
`not_authenticated`.

The collector does not call this binder yet.
CPU policy, installer identity and authentication still need their own checks.

## Next gates

The v2 contract in tunaOS separates the browser producer from the native
test harness. Reuse that contract; do not convert these diagnostics to v1
qualification evidence.

1. Review the immutable producer workflow and frontend tree.
   Get fresh run, `run_attempt`, job and artifact facts from GitHub.
   Verify the exact diagnostic archive against GitHub's artifact digest.
   The adapter in tunaOS accepts only a successful manual run
   on main, with `run_attempt=1`. A failed retained candidate does not meet that policy.
2. Record the installed frontend's Flatpak app ID, full ref, architecture and
   deployed commit. A bundle hash is a separate optional field.
   Do not replace it with the backend executable hash.
3. Restore the retained candidate with an expected hash from an independent
   source. Rehash the same bytes before the native test.
4. Emit v2 evidence from the native harness. Include the exact hash of the
   browser receipt and its media.
   Run both offline plain and encrypted GUI installs on disposable VM disks.
   Boot each installed disk with the ISO detached.
5. Compare with a CI-built ISO from equal source, overlay, installer and engine
   inputs. Each ISO must match its own media hash. Apply freshness checks before
   a target can change its download route.

The current strict harness and parity workflow do not complete this chain.
The native/browser media equality guard must reject mismatched files before
any producer collector is connected.

## Pending manual run

The GitHub connector has no workflow-dispatch operation. A rerun cannot supply
new dispatch inputs. Do not use a push or deploy as a substitute.

After review and merge, the diagnostic run uses
`tuna-os/iso-builder/.github/workflows/ci.yml` with:

```json
{"run_full":true,"only":"yellowfin-gnome","benchmark":false,"keep_iso":false,"retain_candidate":true}
```

The user must select `main` after the reviewed commit has merged, then start a new run.
The transport policy needs `run_attempt=1`.
This is a diagnostic build. These inputs do not complete parity under v2.

Keep the one-candidate limit: ISO at most 10 GiB, provenance at most 1 MiB,
under `browser-iso/candidates/<run-id>/<run-attempt>/yellowfin-gnome/s1/`
in the existing R2 bucket. Refuse overwrite. There is no automatic expiry.
Quota and account-level storage costs remain unverified.

## Tests

Tiny fixtures cover changes to bytes, missing scripts, redirects,
duplicate responses, limits and claimed authentication.
They provide no boot evidence.
The real Chromium fixtures use a tiny document, script, worker, style and WASM.
The execution sandbox can block its local launch. In that case, keep
the mock results separate and run the real fixture in the existing PR CI job.
Do not bypass the sandbox.
