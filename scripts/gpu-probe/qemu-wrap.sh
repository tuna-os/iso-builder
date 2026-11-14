#!/usr/bin/env bash
# QEMU wrapper for the GPU probe. iso-e2e.sh runs "$QEMU"; PROBE_GPU selects what
# changes on the real launches (the ones that carry -name). Probe use only.
real=/usr/bin/qemu-system-x86_64
args=("$@")
if [[ " ${args[*]} " == *" -name "* ]]; then
	case "${PROBE_GPU:-base}" in
	trace)
		args+=(-trace 'virtio_gpu_*' -trace 'vnc_client_*' -D "${PROBE_OUT}/qemu-trace.log")
		;;
	esac
fi
exec "$real" "${args[@]}"
