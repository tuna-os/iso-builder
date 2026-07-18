# TunaOS ISO Builder

Build a bootable **live ISO** from any bootable container image — **entirely in your browser**. No server, no upload: the same engine that CI uses ([tacklebox](https://github.com/tuna-os/tacklebox)) is compiled to WebAssembly and runs client-side.

**Live:** <https://iso.tunaos.org>

## The intended experience

1. Pick a **base** (AlmaLinux Kitten, Fedora, Debian, …) and a **desktop** (GNOME, KDE, COSMIC, Niri, XFCE).
2. Click it → the image is inspected.
3. Click **Build ISO** → the ISO streams to disk.

That's it — no image ref to type, no settings. The community desktops (KDE/COSMIC/Niri/XFCE) aren't published as ISOs, so the builder *is* the way to get them.

Everything else — flatpak preloads, layered system packages ([remora](https://github.com/tuna-os/remora)), custom repos, a custom initramfs or registry relay — lives under **Advanced** and is entirely opt-in. You can also build from an arbitrary bootable container image via *"Or build from any bootable container image."*

## Layout

| Path | What |
|------|------|
| `app/public/` | The web app (static assets, deployed to `iso.tunaos.org` via Cloudflare). `tbox.wasm` is tacklebox built for `GOOS=js GOARCH=wasm`. |
| `app/wrangler.jsonc` | Cloudflare deploy config for the app. |
| `worker/` | `cors-shim.js` — the CORS relay (`relay.tunaos.org`) that proxies GHCR + Flathub/package search so the browser can pull. |
| `e2e/` | Playwright tests that drive the real WASM engine against live infrastructure. |
| `legacy/` | The original stage 1–3 prototype (`erofs.js`, `scanner.js`, `unpack.js`) kept for reference. |

## Develop

```sh
# Serve the app locally
cd app/public && python3 -m http.server 8080   # → http://localhost:8080

# E2E
cd e2e && npm ci && npx playwright install --with-deps chromium
npx playwright test --grep-invert @full        # inspect flow (real network)
```

## Deploy

```sh
cd app    && npx wrangler deploy   # → iso.tunaos.org
cd worker && npx wrangler deploy   # → relay.tunaos.org
```

Deploys need a Cloudflare API token (`CLOUDFLARE_API_TOKEN`) with Workers + Pages scope.

## Updating the WASM engine

`app/public/tbox.wasm` is a build artifact of [tacklebox](https://github.com/tuna-os/tacklebox):

```sh
GOOS=js GOARCH=wasm go build -o tbox.wasm ./cmd/tbwasm
```

Copy the matching `wasm_exec.js` from your Go toolchain (`$(go env GOROOT)/lib/wasm/wasm_exec.js`).
