#!/usr/bin/env bash
# QEMU wrapper for the GPU probe. iso-e2e.sh runs "$QEMU"; PROBE_GPU selects what
# changes on the real launches (the ones that carry -name). Probe use only.
real=${PROBE_QEMU_BIN:-/usr/bin/qemu-system-x86_64}
args=("$@")
if [[ " ${args[*]} " == *" -name "* ]]; then
	case "${PROBE_GPU:-base}" in
	hostsw*)
		# Host-side software GL: virglrenderer rasterises on llvmpipe, the physical GPU only allocates buffers.
		export LIBGL_ALWAYS_SOFTWARE=1 MESA_LOADER_DRIVER_OVERRIDE=kms_swrast GALLIUM_DRIVER=llvmpipe
		;;
	trace)
		args+=(-trace 'virtio_gpu_*' -trace 'vnc_client_*' -D "${PROBE_OUT}/qemu-trace.log")
		;;
	esac
fi
exec "$real" "${args[@]}"
