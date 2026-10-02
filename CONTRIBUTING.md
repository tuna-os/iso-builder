# Contributing to TunaOS ISO Builder

Thank you for your interest in the **TunaOS ISO Builder**! This document gives guidelines and instructions to send contributions to this repository.

---

## Development Setup & Verification

Before you open a pull request, test your changes locally in each affected component.

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
3. **CI Pipeline**: All PRs must pass the automated checks — `native-linux`/`native-windows`/`native-macos`
   (`go vet` + `go test`) and the `e2e` inspect-tier suite. The repository has a golangci-lint config, but CI
   does not run it yet. Run it locally, as the native step above shows.
