#!/usr/bin/env bash
# Build a current QEMU + virglrenderer into /opt/qemu-new for the `newqemu` probe variant.
# The runner's QEMU 8.2.2 / virglrenderer 1.0.0 are the suspects for the virtio-gpu stall.
set -euo pipefail
QEMU_VER=${QEMU_VER:-10.2.0}
VIRGL_VER=${VIRGL_VER:-1.2.0}
PREFIX=/opt/qemu-new
sudo apt-get install -y --no-install-recommends build-essential ninja-build meson pkg-config python3-venv python3-yaml \
	libglib2.0-dev libpixman-1-dev libepoxy-dev libgbm-dev libdrm-dev libegl-dev libgles-dev libgl-dev libslirp-dev \
	libcap-ng-dev libattr1-dev libfdt-dev zlib1g-dev libjpeg-dev libpng-dev flex bison libx11-dev libxext-dev curl xz-utils
work=$(mktemp -d)
cd "$work"
curl -fsSL --retry 3 -o virgl.tgz "https://gitlab.freedesktop.org/virgl/virglrenderer/-/archive/${VIRGL_VER}/virglrenderer-${VIRGL_VER}.tar.gz"
mkdir virgl && tar xzf virgl.tgz -C virgl --strip-components=1
sudo mkdir -p "$PREFIX"
sudo chown "$(id -u)" "$PREFIX"
(cd virgl && meson setup build --prefix="$PREFIX" --libdir=lib -Dvenus=false -Dtests=false -Dbuildtype=release && ninja -C build install)
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
curl -fsSL --retry 3 -o qemu.txz "https://download.qemu.org/qemu-${QEMU_VER}.tar.xz"
mkdir qemu && tar xJf qemu.txz -C qemu --strip-components=1
cd qemu
./configure --prefix="$PREFIX" --target-list=x86_64-softmmu --enable-kvm --enable-opengl --enable-virglrenderer \
	--enable-slirp --disable-docs --disable-werror --disable-user --disable-tools \
	--extra-ldflags="-Wl,-rpath,$PREFIX/lib"
make -j"$(nproc)"
make install
"$PREFIX/bin/qemu-system-x86_64" --version | head -1
"$PREFIX/bin/qemu-system-x86_64" -device help 2>&1 | grep -E "virtio-vga-gl|virtio-gpu-gl" | head -3
"$PREFIX/bin/qemu-system-x86_64" -display help 2>&1 | grep egl-headless
