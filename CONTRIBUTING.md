# Contributing to TunaOS ISO Builder

Thank you for contributing to `iso-builder`! This repository contains both a serverless in-browser WebAssembly ISO builder (`app/` & `worker/`) and a native cross-platform companion application (`native/`).

## Architecture Overview

- `app/`: Static client-side web application deployed to Cloudflare Pages (`iso.tunaos.org`). Uses `tbox.wasm` (tacklebox compiled for WASM) and the File System Access API for streaming downloads.
- `worker/`: Cloudflare Worker (`relay.tunaos.org`) acting as a CORS shim and edge cache proxying GHCR layer blobs.
- `e2e/`: Playwright end-to-end test suite testing browser integration against container registries.
- `native/`: Fyne-based desktop application for initializing and managing persistent multi-boot drives.
- `docs/`: System design specifications and drive management lifecycle details.

## Development & Local Setup

### Web App (`app/`)

1. Build or acquire `tbox.wasm` from `tacklebox`:
   ```bash
   GOOS=js GOARCH=wasm go build -o app/public/tbox.wasm ./cmd/tbwasm
   cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" app/public/
   ```
2. Serve the web application:
   ```bash
   cd app/public && python3 -m http.server 8080
   ```

### Playwright E2E Tests (`e2e/`)

```bash
cd e2e
npm ci
npx playwright install --with-deps chromium
npx playwright test --grep-invert @full
```

### Native Desktop Writer (`native/`)

Refer to [`native/README.md`](native/README.md) for platform-specific prerequisites and build instructions.
- Requires CGO and X11/Wayland/OpenGL headers on Linux.
- Run tests via `go test ./...` (note: GUI tests may require `CGO_ENABLED=1` and X11/GL development packages).

## Deployment

Deployments are managed via Cloudflare Wrangler:

```bash
cd app && npx wrangler deploy      # Deploys to Pages
cd worker && npx wrangler deploy   # Deploys to Workers
```

## Pull Request Guidelines

- Ensure E2E tests pass before submitting PRs (`cd e2e && npx playwright test`).
- Include Developer Certificate of Origin (DCO) sign-off on all commits (`git commit -s`).
