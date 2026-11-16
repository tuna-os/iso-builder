#!/usr/bin/env bash
# run.sh ISO VARIANTS : one strict plain leg per variant, in parallel, with a sidecar each.
set -uo pipefail
ISO=$1; VARIANTS=${2:-base,legacy,egldbg,swgl,trace}
HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS=${HARNESS:-$GITHUB_WORKSPACE/tunaos-e2e-current}
echo "nproc=$(nproc) mem=$(free -g | awk '/Mem:/ {print $2}')G"
ls -l /dev/dri; for c in /sys/class/drm/card*/device/driver; do echo "$c -> $(readlink -f "$c")"; done
command -v nvidia-smi && nvidia-smi -L
qemu-system-x86_64 --version | head -1
MEDIA="sha256:$(sha256sum "$ISO" | cut -d' ' -f1)"
# Host GPU load while the legs run: is another tenant using the card?
mkdir -p "$PWD/pv-host"
(while true; do
	{
		date +%T
		for c in /sys/class/drm/card*/device; do echo "$c busy=$(cat "$c/gpu_busy_percent" 2>/dev/null) vram_busy=$(cat "$c/mem_busy_percent" 2>/dev/null)"; done
		uptime
	} >>"$PWD/pv-host/gpu-busy.log" 2>&1
	sleep 15
done) &
SAMPLER=$!
i=0
IFS=',' read -ra VS <<<"$VARIANTS"
for v in "${VS[@]}"; do
	i=$((i + 1))
	out="$PWD/pv-$v"
	qbin=/usr/bin/qemu-system-x86_64
	if [[ "$v" == newqemu* || "$v" == hostsw* ]]; then
		qbin=/opt/qemu-new/bin/qemu-system-x86_64
		[[ -x "$qbin" ]] || { echo "variant $v skipped: $qbin missing"; continue; }
	fi
	rm -rf "$out"; mkdir -p "$out"
	(
		export PROBE_GPU="$v" PROBE_OUT="$out" QEMU="$HERE/qemu-wrap.sh"
		export TBOX_E2E_SSH_PORT=$((2300 + i)) TBOX_WALKTHROUGH_VNC_PORT=$((5900 + i))
		python3 "$HERE/sidecar.py" "$v" "$((2300 + i))" "$out" "$out/qemu.pid" &
		side=$!
		timeout -k 30 "${LEG_TIMEOUT:-1700}" sudo env \
			VARIANT=yellowfin FLAVOR=xfce PROBE_GPU="$v" PROBE_OUT="$out" QEMU="$HERE/qemu-wrap.sh" PROBE_QEMU_BIN="$qbin" \
			TBOX_E2E_SSH_PORT=$((2300 + i)) TBOX_WALKTHROUGH_VNC_PORT=$((5900 + i)) \
			TUNAOS_QUAL_EXECUTION_KIND=browser STRICT_PUBLISHED_MEDIA=0 \
			TUNAOS_QUAL_SOURCE_DIGEST=sha256:d56b3e8448d9ccb02343ce2c23f515304b26eebecd78c7960f41623a8240d10d \
			TUNAOS_QUAL_SOURCE_CONFIG_DIGEST=sha256:9b5160818cc314e2acd9a6f88d98e39c452167f408994a7cec4a25edc91c5e2b \
			TUNAOS_QUAL_SOURCE_REF=ghcr.io/tuna-os/yellowfin:xfce \
			TUNAOS_QUAL_OVERLAY_DIGEST=sha256:229d14553e9c581342e3c7cb320904023504cff1b92b6fe582836f99ef72b004 \
			TUNAOS_QUAL_INSTALLER_DIGEST=sha256:e9739fcdb39fb32d1ff34c5399391a5613e05e12ee357fdecb802a4349a61b63 \
			TUNAOS_QUAL_ENGINE_DIGEST=sha256:53f9d21b2cbc2d87cfb012ce613f6e9b7e94374c80ca20ead678d2ecadedc550 \
			TUNAOS_QUAL_MEDIA_DIGEST="$MEDIA" \
			TUNAOS_QUAL_PLATFORM=linux/amd64 TUNAOS_QUAL_CPU_BASELINE=x86-64 TUNAOS_QUAL_HARDWARE_SCOPE=qemu \
			TUNAOS_QUAL_BROWSER_NAME=probe TUNAOS_QUAL_BROWSER_VERSION=0 \
			"$HARNESS/scripts/iso-e2e.sh" "$ISO" --strict-offline-gui=plain --output "$out" --timeout 900 \
			>"$out/harness.log" 2>&1
		echo "leg $v exit=$?" >>"$out/harness.log"
		kill "$side" 2>/dev/null
		[[ -f "$out/qemu.pid" ]] && sudo kill "$(cat "$out/qemu.pid")" 2>/dev/null
	) &
	sleep 20
done
wait
kill "$SAMPLER" 2>/dev/null
sudo dmesg 2>&1 | tail -n 80 >"$PWD/pv-host/host-dmesg.txt"
for v in "${VS[@]}"; do echo "== $v: $(tail -n 1 "pv-$v/harness.log")"; done

for v in "${VS[@]}"; do
	echo "::group::$v harness log (filtered)"
	grep -aE '^(ok|not ok|ERROR|==>|#|offline|installed|strict)' "pv-$v/harness.log" | tail -n 120
	echo "::endgroup::"
	echo "::group::$v sidecar"
	head -c 400000 "pv-$v/sidecar.log"
	echo "::endgroup::"
	[[ -f "pv-$v/qemu-trace.log" ]] && { echo "::group::$v qemu trace tail"; tail -n 400 "pv-$v/qemu-trace.log"; echo "::endgroup::"; }
	for j in "pv-$v"/walkthrough-plain/walkthrough-xfce.json; do [[ -f "$j" ]] && { echo "::group::$v walkthrough json"; head -c 3000 "$j"; echo "::endgroup::"; }; done
done
