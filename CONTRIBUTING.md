# Contributing to TunaOS ISO Builder

Thank you for your interest in contributing to the **TunaOS ISO Builder**! This document provides guidelines and instructions for submitting contributions to this repository.

---

## Development Setup & Verification

Before opening a pull request, ensure your changes have been tested locally across the affected components.

### 1. Web Application (`app/public`)
- Ensure `tbox.wasm` and `wasm_exec.js` are populated as described in [README.md](README.md#develop).
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
  CI does not run this yet, so lint it yourself before opening a PR (the config's
  `formatters` section runs `gofmt`/`goimports` as part of this too):
  ```sh
  cd native
  golangci-lint run
  ```

---

## Submitting Pull Requests

1. **Branch Naming & DCO**: Create a feature or bugfix branch. Sign all commits with Developer Certificate of Origin (`git commit -s`).
2. **Pull Requests**: Open a pull request against the `main` branch. Provide a clear description of the changes and link any related issues.
3. **CI Pipeline**: All PRs must pass automated check workflows — `native-linux`/`native-windows`/`native-macos`
   (`go vet` + `go test`) and the `e2e` inspect-tier suite. golangci-lint is configured but not yet wired into
   CI (run it locally per the native step above).
