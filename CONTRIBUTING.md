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
- Verify native desktop code formatting, linting, and tests (see [`native/README.md`](native/README.md)):
  ```sh
  cd native
  go test ./...
  ```

---

## Submitting Pull Requests

1. **Branch Naming & DCO**: Create a feature or bugfix branch. Sign all commits with Developer Certificate of Origin (`git commit -s`).
2. **Pull Requests**: Open a pull request against the `main` branch. Provide a clear description of the changes and link any related issues.
3. **CI Pipeline**: All PRs must pass automated check workflows (E2E tests, native builds, lint checks).
