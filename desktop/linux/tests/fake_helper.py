#!/usr/bin/env python3
"""A stand-in for tunaos-media-helper that speaks protocol v1 (desktop/PROTOCOL.md).

Used by the unit tests and by `tunaos-media-writer --fake-helper PATH` for the
UI smoke run. It never touches a real disk: its drives are regular files in
$FAKE_HELPER_DIR, and `write --fd N` writes to whatever file the caller opened.

Environment:
  FAKE_HELPER_DIR        where fake drive images live (default: $TMPDIR/tunaos-fake-helper-<uid>)
  FAKE_HELPER_DRIVES     JSON file with a `drives` list replacing the default one stick
  FAKE_HELPER_FAIL       "<subcommand>:<error kind>", e.g. "build:network"
  FAKE_HELPER_DELAY      seconds between progress events (default 0.02)
  FAKE_HELPER_ISO_BYTES  size of the fake ISO (default 2 MiB)
"""

import argparse
import hashlib
import json
import os
import signal
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK = 256 * 1024

_events_path = None


def write(obj):
    line = json.dumps(obj) + "\n"
    if _events_path:
        with open(_events_path, "a", encoding="utf-8") as fh:
            fh.write(line)
    else:
        sys.stdout.write(line)
        sys.stdout.flush()


def emit(event, **fields):
    write({"event": event, **fields})


def log(message):
    print(f"fake-helper: {message}", file=sys.stderr, flush=True)


def fail(kind, message, code=1):
    emit("error", kind=kind, message=message)
    sys.exit(code)


def on_term(_signum, _frame):
    emit("error", kind="cancelled", message="Cancelled.")
    sys.exit(130)


def delay():
    time.sleep(float(os.environ.get("FAKE_HELPER_DELAY", "0.02")))


def maybe_fail(subcommand, at):
    spec = os.environ.get("FAKE_HELPER_FAIL", "")
    if spec.startswith(subcommand + ":") and at:
        kind = spec.split(":", 1)[1]
        messages = {
            "network": "Could not reach ghcr.io. Check your internet connection.",
            "storage": "Building needs 9 GB of free space, but only 3 GB is available.",
            "verify-mismatch": "What was read back from the USB stick does not match the ISO.",
            "device-changed": "The USB stick changed since it was selected.",
        }
        fail(kind, messages.get(kind, "The engine failed."))


def fake_dir():
    path = os.environ.get("FAKE_HELPER_DIR") or os.path.join(tempfile.gettempdir(), f"tunaos-fake-helper-{os.getuid()}")
    os.makedirs(path, exist_ok=True)
    return path


def drives():
    override = os.environ.get("FAKE_HELPER_DRIVES")
    if override:
        with open(override, encoding="utf-8") as fh:
            return json.load(fh)["drives"]
    return [
        {
            "id": "fake:usb-SanDisk_Ultra_4C530001",
            "path": os.path.join(fake_dir(), "sandisk-ultra.img"),
            "name": "SanDisk Ultra",
            "sizeBytes": 32015679488,
            "bus": "usb",
            "removable": True,
            "mounted": ["/run/media/user/STICK"],
            "systemDisk": False,
        }
    ]


def cmd_version(_args):
    emit("version", helper="0.0.0-fake", engine="fake", protocol=1)


def cmd_catalog(_args):
    path = os.environ.get("FAKE_HELPER_CATALOG") or os.path.join(HERE, "fixtures", "catalog.json")
    with open(path, encoding="utf-8") as fh:
        catalog = json.load(fh)
    maybe_fail("catalog", True)
    emit("log", level="warn", message="Using the catalog bundled with the helper (offline).")
    write(catalog)


def cmd_drives(_args):
    maybe_fail("drives", True)
    emit("drives", drives=drives())


def cmd_build(args):
    if not args.target and not args.request:
        fail("usage", "build needs --target or --request", 2)
    size = int(os.environ.get("FAKE_HELPER_ISO_BYTES", str(2 * 1024 * 1024)))
    log(f"building {args.target or args.request} -> {args.out}")
    # Forward compatibility: unknown events and stray lines must be ignored.
    emit("future-event", detail="ignored by protocol v1 GUIs")
    print("not json", flush=True)
    total = 40 * CHUNK
    for current in range(0, total + 1, 4 * CHUNK):
        emit("progress", phase="download", current=current, total=total, unit="bytes", message="Downloading")
        maybe_fail("build", current >= total // 2)
        delay()
    for phase, steps, unit in (("unpack", 6, "layers"), ("overlay", 3, "steps"), ("erofs", 5, "steps"),
                               ("esp", 2, "steps"), ("iso", 4, "steps")):
        for step in range(1, steps + 1):
            emit("progress", phase=phase, current=step, total=steps, unit=unit, message=f"{phase} {step}/{steps}")
            delay()
    data = bytearray(size)
    data[32769:32774] = b"CD001"
    with open(args.out, "wb") as fh:
        fh.write(data)
    emit("done", path=os.path.abspath(args.out), bytes=size, sha256=hashlib.sha256(data).hexdigest())


def cmd_write(args):
    drive = next((d for d in drives() if d["id"] == args.device or d["path"] == args.device), None)
    if drive is None:
        fail("device-changed", "The USB stick changed since it was selected.")
    with open(args.iso, "rb") as fh:
        iso = fh.read()
    if args.fd is not None:
        target = os.fdopen(args.fd, "r+b", buffering=0)
    else:
        target = open(drive["path"], "r+b" if os.path.exists(drive["path"]) else "w+b", buffering=0)
    log(f"writing {len(iso)} bytes to {'fd %d' % args.fd if args.fd is not None else drive['path']}")
    with target:
        for offset in range(0, len(iso), CHUNK):
            target.seek(offset)
            target.write(iso[offset:offset + CHUNK])
            emit("progress", phase="write", current=offset + CHUNK, total=len(iso), unit="bytes", message="Writing")
            maybe_fail("write", offset >= len(iso) // 2)
            delay()
        os.fsync(target.fileno())
        verified = False
        if not args.no_verify:
            digest = hashlib.sha256()
            for offset in range(0, len(iso), CHUNK):
                target.seek(offset)
                digest.update(target.read(min(CHUNK, len(iso) - offset)))
                emit("progress", phase="verify", current=offset + CHUNK, total=len(iso), unit="bytes", message="Verifying")
                delay()
            if digest.hexdigest() != hashlib.sha256(iso).hexdigest():
                fail("verify-mismatch", "What was read back from the USB stick does not match the ISO.")
            verified = True
    emit("done", device=drive["path"], bytes=len(iso), verified=verified)


def main():
    global _events_path
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--events")
    common.add_argument("--cancel-file")
    parser = argparse.ArgumentParser(prog="fake-helper", parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", parents=[common])
    p = sub.add_parser("catalog", parents=[common])
    p.add_argument("--base-url")
    p = sub.add_parser("drives", parents=[common])
    p.add_argument("--exclude")
    p = sub.add_parser("build", parents=[common])
    p.add_argument("--target")
    p.add_argument("--request")
    p.add_argument("--out", required=True)
    p.add_argument("--workdir")
    p.add_argument("--flatpaks")
    p.add_argument("--base-url")
    p = sub.add_parser("write", parents=[common])
    p.add_argument("--iso", required=True)
    p.add_argument("--device", required=True)
    p.add_argument("--fd", type=int)
    p.add_argument("--no-verify", action="store_true")
    try:
        args = parser.parse_args()
    except SystemExit:
        emit("error", kind="usage", message="Invalid arguments.")
        sys.exit(2)
    _events_path = args.events
    {"version": cmd_version, "catalog": cmd_catalog, "drives": cmd_drives, "build": cmd_build, "write": cmd_write}[
        args.command
    ](args)


if __name__ == "__main__":
    main()
