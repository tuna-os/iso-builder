# Contributing to TunaOS ISO Builder

Thank you for your interest in the **TunaOS ISO Builder**! This document gives guidelines and instructions to send contributions to this repository.

---

<!-- hive-contribute-plea: donated-compute appeal, keep in sync across repos -->
## Contribute compute — no code needed

**[Donate time with your AI CLI](https://hub.tunaos.org/#contribute).**

Your machine runs one task at a time using your signed-in AI coding CLI.
The relay alternates between eligible **School** (OS) and **Reef** (apps)
hives after each task. If one hive has no work, the other can continue.

The guide covers prerequisites, verified `just` setup, credentials, provider
costs, and how to stop with Ctrl+C. Your subscription quota or API charges apply.
Never post account credentials or API keys in issues or pull requests.

## Development Setup & Verification

Before you open a pull request, test your changes locally in each affected component.

Run the offline Python and JavaScript checks from the repository root with
`just check`, or run only JavaScript with `just test-node`. That recipe gives
the test filenames to Node: `node --test tests/ worker/` fails with
`MODULE_NOT_FOUND` on Node 24.19 before it runs the tests.

`just check` runs `python3 -m pytest -q tests` first. CI runs the same suite as
the `qualification-contract` check. Then it runs the Node suites in
`tests/*.test.cjs` and the relay suite in `worker/*.test.js`. Before you run it,
install `just`, Node.js, and Python 3 with the PyPI packages `pytest` and
`PyYAML`:

```sh
python3 -m pip install pytest PyYAML
```

Some of the Python tests run `just`. If `mkfs.erofs` (`erofs-utils`) or
`mksquashfs` and `unsquashfs` (`squashfs-tools`) are not installed, pytest skips
the tests that need them. To run only the relay tests, use `cd worker && npm test`.

### JavaScript unit tests (`tests/*.test.cjs`)

If you change a JavaScript helper (configuration checks, catalog selection or
Flatpak defaults), start with the offline unit suites. Use the Node.js version
that `actions/setup-node` selects in [CI](.github/workflows/ci.yml). Run one
suite while you work, from the repository root:

```sh
node --test tests/builder-config-flatpak-ids.test.cjs
```

These suites use the Node test runner with local CommonJS helpers and fixtures.
They need no `npm install`, WASM build, browser, native GUI toolkit, registry
access or credentials.

If you change the browser UI or the WASM engine, also run the
[Playwright end-to-end checks](#2-end-to-end-tests-e2e). If you change the
native Go application, run the [native checks](#3-native-application-native).
The offline suites do not replace those checks.

### 1. Web Application (`app/public`)
- Put `tbox.wasm` and `wasm_exec.js` in place, as [README.md](README.md#develop) describes.
- Serve locally:
  ```sh
  cd app/public && python3 -m http.server 8080
  ```

### 2. End-to-End Tests (`e2e/`)
- Run Playwright test suite to verify UI and WASM functionality:
  ```sh
  cd e2e
  npm ci
  npx playwright install --with-deps chromium
  npx playwright test --grep-invert @full
  ```

Test user actions in the browser. Do not test the exact text in HTML.

### 3. Native Application (`native/`)
- Run tests (see [`native/README.md`](native/README.md) for platform build prerequisites):
  ```sh
  cd native
  go vet ./...
  go test ./...
  ```
- `native/` also carries a [`.golangci.yml`](.golangci.yml) (schema `version: "2"`, so it needs
  golangci-lint v2, e.g. `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest`).
  CI does not run this yet, so lint it yourself before you open a PR. The
  `formatters` section of the config also runs `gofmt`/`goimports`:
  ```sh
  cd native
  golangci-lint run
  ```

---

## Submitting Pull Requests

1. **Branch Naming & DCO**: Create a feature or bugfix branch. Sign all commits with Developer Certificate of Origin (`git commit -s`).
2. **Pull Requests**: Open a pull request against the `main` branch. Provide a clear description of the changes and link any related issues.
3. **CI Pipeline**: The `main` ruleset needs three checks to pass. They are `qualification-contract`
   (`python -m pytest -q tests`, the same as `just test`), `native-linux` (`go vet` + `go test -race`)
   and `wasm` (the engine build). `native-windows`, `native-macos` and the `e2e` inspect tier also run,
   but they do not block a merge. Make them pass too. Each job runs only when its paths change, so a
   pull request that changes only Markdown, `docs/`, `examples/` or `desktop/` skips them. The
   repository has a golangci-lint config, but CI does not run it yet. Run it locally, as the native
   step above shows.
4. **Other checks**: Two more workflows can fail a pull request. They are not in the `main` ruleset.
   - `actions-security.yml` runs on every pull request. Its `lockfile` job verifies
     `.github/workflows/actions.lock`, and its `zizmor` job scans the workflows for security
     problems. If you add a workflow or change a `uses:` line, update `actions.lock` in the same
     pull request. Install the `gh` extension at the version that CI uses, then run it from the
     repository root:

     ```sh
     gh extension install github/gh-actions-lock --pin v0.4.1
     gh actions-lock
     ```

   - `ste.yml` (the `Prose` workflow) runs when a pull request changes Markdown. It checks
     `README.md`, `CONTRIBUTING.md` and the files in `docs/` against Simplified Technical English.
     The budget in `.ste-budget` is `0`, so one new finding makes the check fail. To run the same
     linter, you need Node.js and a clone of [tuna-os/.github](https://github.com/tuna-os/.github).
     From the root of this repository, run:

     ```sh
     node ../.github/.github/actions/ste-lint/ste-lint.mjs --max 0
     ```

     Change `../.github` if you cloned tuna-os/.github to a different directory.
