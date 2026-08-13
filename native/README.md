# tacklebox-app

Native, cross-platform companion to the browser ISO builder (`../app`): instead of
downloading an ISO, it writes a persistent, updatable multi-boot drive directly to a
USB stick using the real `tacklebox` binary. See [tuna-os/iso-builder#3](https://github.com/tuna-os/iso-builder/issues/3)
for why that's the point, not building yet another ISO burner.

## Status

Builds on all three platforms — Linux, Windows, and macOS each have their own
job in `.github/workflows/ci.yml` (`native-linux`/`native-windows`/`native-macos`,
on `ubuntu-latest`/`windows-latest`/`macos-latest`), rather than one
cross-compiled job, because the platform-specific files (`exec_windows.go`,
`exec_darwin.go`, `blockdev_windows.go`, `blockdev_darwin.go`, `managed_windows.go`,
`managed_darwin.go`, `vm_darwin.go`) are only ever compiled on their own GOOS.
Linux runs `tacklebox` directly; Windows and macOS both boot/attach a real Linux
environment first (WSL2 on Windows, a bundled QEMU VM on macOS) and run the same
flow inside it, since `bootc install` needs real Linux kernel semantics — see
[tuna-os/tacklebox#107](https://github.com/tuna-os/tacklebox/issues/107) and
[tuna-os/tacklebox#108](https://github.com/tuna-os/tacklebox/issues/108) for why.
See [tuna-os/iso-builder#1](https://github.com/tuna-os/iso-builder/issues/1)'s
comments for current live-verification status per platform, and
`native/package/README.md` for packaging/signing state.

Requires a `tacklebox` binary on `PATH`, or next to this executable.

The catalog search supports `base:bonito`, `de:gnome`, and `arch:arm64`
filters. To try an image that is not yet curated, paste an OCI-style reference
such as `oci://ghcr.io/example/workstation:latest` (or `docker://`/`ghcr://`)
into the search field. Generated recipes include a best-effort live-overlay
customization based on the image base and desktop; failures are warnings and
do not make the image unusable.

The guided front door is a persistent, extendable drive: a blank or foreign
disk is explicitly initialized once, then managed disks show their status and
offer Add, Update, Verify, and Remove. The live installer-environment mode is
retained as the secondary option for users who intentionally need a one-shot
installer.

## Building

Uses [Fyne](https://fyne.io) (pure Go, no WebKit dependency — deliberately avoided
Tauri/Wails because `webkit2gtk-4.1` isn't available on stock bootc-based Linux
without layering a package, which is too invasive to require of every dev machine).

Fyne's Linux backend (GLFW) needs X11/Wayland/OpenGL dev headers. On a Homebrew-on-Linux
setup, `pkg-config` resolves the include/lib paths correctly, but they need to be fed to
cgo explicitly since brew's per-formula Cellar layout isn't on the compiler's default
search path:

```sh
CF=$(pkg-config --cflags x11 xrandr xcursor xinerama xi xext xxf86vm gl wayland-client wayland-cursor wayland-egl xkbcommon)
LF=$(pkg-config --libs   x11 xrandr xcursor xinerama xi xext xxf86vm gl wayland-client wayland-cursor wayland-egl xkbcommon)
go env -w CGO_CFLAGS="$CF" CGO_LDFLAGS="$LF"   # persists for all subsequent go commands
go build -o tacklebox-app .
```

On a distro with `webkit2gtk`/X11 dev packages installed the normal way, plain `go build`
should just work without any of the above.

## Testing

The safety filter is unit-tested independently of the live drive-enumeration call on
each platform (`filterSafeDrives` in `blockdev_linux.go`, and the same split in
`blockdev_windows_test.go`) — same pattern as `tuna-os/tacklebox`'s
`internal/blockdev/darwin` package (see [tuna-os/tacklebox#106](https://github.com/tuna-os/tacklebox/issues/106)/[#109](https://github.com/tuna-os/tacklebox/issues/109)
for why: enumeration/filter has to be independently testable, since virtual/loopback test
devices are correctly excluded by the filter itself and can never exercise this code path
live).

```sh
go test ./...
```
