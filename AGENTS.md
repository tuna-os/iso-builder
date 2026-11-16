# AGENTS.md — agent guide for tuna-os/iso-builder

Build a bootable **live ISO from any bootc image, entirely in the browser** —
no server, no upload. The same engine CI uses
([tacklebox](https://github.com/tuna-os/tacklebox)) compiled to WebAssembly and
run client-side, served from <https://iso.tunaos.org>. `native/` is the
desktop app around the same engine; `worker/` is the CORS relay.

Human docs: [`README.md`](README.md) (architecture, the relay sequence
diagram), [`native/README.md`](native/README.md),
[`native/package/README.md`](native/package/README.md) (signing).

## The engine is not in this repo

ISO-building behaviour lives in **tacklebox**. This repo pins it as a Go module
in `native/go.mod` (Renovate bumps the digest), and CI rebuilds
`app/public/tbox.wasm` from tacklebox at that pinned commit.

So `app/public/tbox.wasm` and `app/public/wasm_exec.js` are **build output,
not source**, and `.gitignore` excludes them (`app/**/*.wasm`). The `wasm` job
builds the engine. The `e2e` job puts that artifact in `app/public/` and tests
it. The `deploy` job ships the same artifact. Two consequences:

- Do not commit a rebuilt `tbox.wasm` (or `git add -f` one). Git cannot
  delta-compress a `.wasm` file, so each revision adds 12 MB of permanent
  history. This repo history already holds six revisions (#152).
- To change what the builder does, change tacklebox and bump the pin here.

`wasm_exec.js` is taken from `$(go env GOROOT)/lib/wasm/` rather than git,
because that shim must match the compiler that produced the binary — a second
blob that can skew independently.

Resolving the pin has a wrinkle worth knowing: a Go pseudo-version carries a
12-char abbreviated commit, and `actions/checkout` cannot resolve one (it
fetches the ref verbatim and git exits 1), so the workflow expands it to a full
SHA through the API first.

## Three OS-native jobs, because Go hides files from you

`exec_windows.go`, `exec_darwin.go`, `blockdev_*.go`, `managed_*.go` and
`vm_darwin.go` carry filename build constraints. `go vet`/`test`/`build` on
Linux **silently never touches any of them** — confirmed with
`go list -f '{{.GoFiles}}'`. Under a single Linux job, a broken commit to any
Windows- or macOS-only file merged with fully green CI. Hence `native-linux`,
`native-windows` and `native-macos` on real runners.

`native-windows`, `native-macos` and `e2e` are **skipped on
`workflow_dispatch`** on purpose: a nine-cell full-matrix sweep used to drag
~36 jobs that prove nothing about the engine while competing for the runner
pool the cells need. Required checks are evaluated from `pull_request` runs
regardless, so that skip cannot weaken a merge gate.

## Required checks on `main`

The repository ruleset "tier-b: required checks" requires three checks on
`main`: `qualification-contract` (`python -m pytest -q tests`, the same as
`just test`), `native-linux` and `wasm`. An organization ruleset also blocks
deletion and force pushes.

`native-windows`, `native-macos` and `e2e` are not required checks. A red
result from one of them does not block a merge, so read their results before
you merge. Each job also runs only when its paths change (the `changes` job),
and GitHub counts a skipped required check as passed. A pull request that
changes only Markdown, `docs/`, `examples/` or `desktop/` runs none of them.

## What the e2e tiers prove

The e2e suite is two tiers:

- **`e2e`** — runs on each pull request and push that changes code,
  `--grep-invert @full`. Page load and inspect only, ~2 min, no ISO written.
  It is the only browser check on a pull request, but it is not required.
- **`full-matrix`** — dispatch-only, one cell per base variant, each building
  and validating a multi-GB ISO.

`@full` is a **format** proof: size >100 MB and the ISO9660 `CD001` magic at
sector 16. The **boot** proof is the step chained behind it, which installs
each ISO with LUKS under QEMU and verifies the installed system reboots
(tunaOS `scripts/iso-e2e.sh`).

**Expect `full-matrix` to be mostly red, and do not "fix" it by raising
budgets.** Measurement found two independent engine bugs, not one:

1. A non-deterministic hang fetching layers — Go's js/wasm
   `streamReader.Read` selects only on the read promise, with no context
   case, so a stalled response body blocks forever and no deadline can break
   it. Different layer each run.
2. The **wasm32 4 GiB ceiling** — Go targets 32-bit linear memory, so the
   unpacked tree, the EROFS image and the ISO share one address space.
   `flounder:xfce` is the smallest edition and the only one to get past (1),
   where it dies at 4094 MB.

## Concurrency is tuned, not boilerplate

Dispatch runs get their own group keyed on `run_id` so a sweep neither cancels
nor is cancelled — a shared branch key once wiped six cells mid-pull as "The
operation was canceled", and the sweep taught us nothing about those bases.
Everything else groups on `head_ref || ref`, after tacklebox piled up 26+ stale
Renovate-rebase runs and starved the shared macOS/Windows pool
([tacklebox#139](https://github.com/tuna-os/tacklebox/issues/139)).

## Deploys are automatic on `main`

The `deploy` job publishes **both** `iso.tunaos.org` (`app/`) and
`relay.tunaos.org` (`worker/`) via wrangler on every push to `main`. A change
to `worker/cors-shim.js` is a production change to the relay every browser
build depends on.

## Checks

```bash
cd native && go vet ./... && go test -race ./...   # needs the GUI toolkit headers
just test                                          # the required qualification-contract check
cd e2e && npx playwright test --grep-invert @full  # the e2e inspect tier
```

`native-linux` installs `libgl1-mesa-dev xorg-dev libxxf86vm-dev
libwayland-dev libxkbcommon-dev` before vetting; without them the Go build
fails on missing X11 headers rather than on anything in the code. Packaging
recipes live in `native/justfile` — note the Windows cross-build warning
there about leftover `CGO_CFLAGS`/`CGO_LDFLAGS` from a native Linux Fyne
build producing "cannot find -lX11" errors that have nothing to do with
Windows.
