#!/usr/bin/env bash
# Build QEMU and virglrenderer from pinned sources into /opt/tunaos-qemu.
#
# Why: the karnataka GPU runner's Ubuntu 24.04 QEMU 8.2.2 + virglrenderer 1.0.0
# stalls virtio-gpu scanout under egl-headless. The EL10 XFCE guest (cage and
# xfwl4 on virgl) paints the installer, then the display freezes on the progress
# page while the install carries on ('kworker commit_work' blocked in
# drm_atomic_helper_wait_for_fences). The same ISO on QEMU 10.2.0 + virglrenderer
# 1.2.0 finished the whole plain install on the same runner (probe run
# 43663348488, yellowfin-xfce). The build takes about two minutes on that host.
#
# The tunaOS strict harness (scripts/iso-e2e.sh) prefers
# /opt/tunaos-qemu/bin/qemu-system-x86_64 when it exists. A failed build is a
# warning, not a failure: the harness then uses the distribution QEMU.
set -euo pipefail

PREFIX=${TUNAOS_QEMU_PREFIX:-/opt/tunaos-qemu}
QEMU_VER=10.2.0
QEMU_SHA256=9e30ad1b8b9f7b4463001582d1ab297f39cfccea5d08540c0ca6d6672785883a
VIRGL_TAG=1.2.0
VIRGL_COMMIT=500b41d5c8638f9b80dd558f4044f3301c7457a4

# QEMU source patch (tunaOS#4768). virtio-gpu's control/cursor BHs and the
# virgl command-queue resume BH live in qemu_aio_context by default, which a
# vCPU thread also polls during synchronous block I/O (pflash EFI variable
# writes at the installer's bootloader step). virglrenderer then switched GL
# contexts on that thread, eglMakeCurrent failed with EGL_BAD_ACCESS, and
# virglrenderer disabled the compositor's context for good: the display froze
# on niri and EL10 XFCE while the install carried on. The patch moves the three
# BHs to the main-loop-only iohandler context. yellowfin-xfce run 44760338726:
# 0 EGL_BAD_ACCESS and 0 context errors on both legs (was 1 per frozen run).
patch="$(cd "$(dirname "$0")" && pwd)/virtio-gpu-main-loop-bh.patch"
stamp="${QEMU_VER}+virgl-${VIRGL_COMMIT}+$(sha256sum "$patch" | cut -c1-16)"

if [[ -x "$PREFIX/bin/qemu-system-x86_64" && "$(cat "$PREFIX/.build-stamp" 2>/dev/null)" == "$stamp" ]]; then
	echo "ok - $PREFIX already holds $("$PREFIX/bin/qemu-system-x86_64" --version | head -1) ($stamp)"
	exit 0
fi

sudo apt-get install -y --no-install-recommends build-essential git ca-certificates ninja-build meson \
	pkg-config python3-venv python3-yaml libglib2.0-dev libpixman-1-dev libepoxy-dev libgbm-dev \
	libdrm-dev libegl-dev libgles-dev libgl-dev libslirp-dev libcap-ng-dev libattr1-dev libfdt-dev \
	zlib1g-dev libjpeg-dev libpng-dev flex bison libx11-dev libxext-dev curl xz-utils

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sudo mkdir -p "$PREFIX"
sudo chown "$(id -u):$(id -g)" "$PREFIX"

git clone --quiet --depth 1 --branch "$VIRGL_TAG" https://gitlab.freedesktop.org/virgl/virglrenderer.git "$work/virgl"
[[ "$(git -C "$work/virgl" rev-parse HEAD)" == "$VIRGL_COMMIT" ]] || {
	echo "virglrenderer $VIRGL_TAG is not commit $VIRGL_COMMIT" >&2
	exit 1
}
(cd "$work/virgl" && meson setup build --prefix="$PREFIX" --libdir=lib -Dvenus=false -Dtests=false -Dbuildtype=release &&
	ninja -C build install)

curl -fsSL --retry 3 -o "$work/qemu.txz" "https://download.qemu.org/qemu-${QEMU_VER}.tar.xz"
echo "${QEMU_SHA256}  $work/qemu.txz" | sha256sum -c -
mkdir "$work/qemu"
tar xJf "$work/qemu.txz" -C "$work/qemu" --strip-components=1
(cd "$work/qemu" && patch -p1 --forward <"$patch")
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
(cd "$work/qemu" &&
	./configure --prefix="$PREFIX" --target-list=x86_64-softmmu --enable-kvm --enable-opengl \
		--enable-virglrenderer --enable-slirp --disable-docs --disable-werror --disable-user \
		--disable-tools --extra-ldflags="-Wl,-rpath,$PREFIX/lib" &&
	make -j"$(nproc)" && make install)

echo "$stamp" >"$PREFIX/.build-stamp"
"$PREFIX/bin/qemu-system-x86_64" --version | head -1
"$PREFIX/bin/qemu-system-x86_64" -device help 2>&1 | grep -E 'virtio-vga-gl|virtio-gpu-gl' | head -3
"$PREFIX/bin/qemu-system-x86_64" -display help 2>&1 | grep egl-headless
