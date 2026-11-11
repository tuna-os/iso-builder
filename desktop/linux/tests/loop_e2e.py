#!/usr/bin/env python3
"""Write path end to end on a udisks2 loop device — never a real disk.

Creates a file-backed loop device through udisks2 with a mounted FAT
filesystem on it, then runs the app's Controller write step for real:
helper `drives` merged with udisks2 → Filesystem.Unmount →
Block.OpenDevice("rw", O_EXCL) → fd passed to `<helper> write --fd 3` →
done event with verified=true; then checks the bytes on the loop device.

Needs udisks2 and polkit authorization for loop-setup/mount/open-device
(run as root, or from a session that can answer the prompt).

    sudo python3 tests/loop_e2e.py                       # fake helper
    sudo TUNAOS_MEDIA_HELPER=/path/tunaos-media-helper python3 tests/loop_e2e.py
      (a helper built with `-tags testdevices`; the script sets
       TUNAOS_MEDIA_HELPER_TEST_DEVICES to the loop device)

`--device /dev/loopN --iso FILE` skips the setup and uses an existing loop
device, e.g. from inside the Flatpak sandbox (no /dev there: the read-back
check is then left to the caller).
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))

from gi.repository import GLib  # noqa: E402

import tunaos_media_writer  # noqa: E402
from tunaos_media_writer.catalog import Catalog  # noqa: E402
from tunaos_media_writer.controller import Controller  # noqa: E402
from tunaos_media_writer.flow import DriveDestination, Flow, Source, Step  # noqa: E402
from tunaos_media_writer.udisks import UDisks  # noqa: E402

ISO_BYTES = 24 * 1024 * 1024
IMAGE_BYTES = 64 * 1024 * 1024


def run(*argv: str) -> str:
    print("+", " ".join(argv), flush=True)
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()


def make_iso(path: str) -> None:
    data = bytearray(os.urandom(ISO_BYTES))
    data[32769:32774] = b"CD001"
    with open(path, "wb") as fh:
        fh.write(data)


def write_with_controller(loop: str, iso: str, work: str) -> None:
    # Both the testdevices helper and the GUI's udisks2 cross-check honour it.
    os.environ["TUNAOS_MEDIA_HELPER_TEST_DEVICES"] = loop
    helper = os.environ.get("TUNAOS_MEDIA_HELPER")
    if helper:
        argv = [helper]
    else:
        argv = [sys.executable, os.path.join(HERE, "fake_helper.py")]
        drives_file = os.path.join(work, "drives.json")
        with open(drives_file, "w") as fh:
            json.dump({"drives": [{"id": f"{loop}|{IMAGE_BYTES}|test", "path": loop, "name": "", "sizeBytes": IMAGE_BYTES,
                                   "bus": "other", "removable": True, "systemDisk": False}]}, fh)
        os.environ["FAKE_HELPER_DRIVES"] = drives_file
    print(f"app code: {tunaos_media_writer.__file__}; helper: {argv}", flush=True)

    udisks = UDisks.connect()
    assert udisks is not None, "udisks2 is required"
    flow = Flow()
    controller = Controller(flow, argv, udisks, os.path.join(work, "cache"))
    context = GLib.MainContext.default()

    def spin(until, seconds):
        deadline = time.monotonic() + seconds
        while not until() and time.monotonic() < deadline:
            context.iteration(False)
            time.sleep(0.005)

    # Step 2 for real: the helper's drive list, merged with udisks2.
    controller.refresh_drives()
    spin(lambda: controller.drives, 30)
    choice = next((c for c in controller.drives if c.drive.path == loop), None)
    assert choice is not None, f"{loop} not offered: {controller.drives} {controller.details}"
    print(f"offered: {choice.label} {choice.drive}", flush=True)

    flow.catalog_loaded(Catalog([], [], []))
    source = Source(label="loop e2e", save_name="tunaos.iso", target_id="loop-e2e")
    flow.choose(source)
    # The ISO is already built: start() reuses it and goes straight to writing.
    controller._built = (source.key, iso)
    controller.start(DriveDestination(choice.drive, choice.label))
    spin(lambda: flow.step is not Step.PROGRESS, 300)
    print("\n".join(controller.details), flush=True)
    assert flow.step is Step.DONE, f"ended at {flow.step}: {flow.error}"
    assert flow.result.verified, flow.result
    print(f"done: {flow.result}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", help="existing loop device to write (skips setup and read-back)")
    parser.add_argument("--iso", help="ISO to write with --device")
    args = parser.parse_args()
    if args.device:
        write_with_controller(args.device, args.iso, tempfile.mkdtemp(prefix="mw-loop-e2e-"))
        return 0

    work = tempfile.mkdtemp(prefix="mw-loop-e2e-")
    image = os.path.join(work, "stick.img")
    with open(image, "wb") as fh:
        fh.truncate(IMAGE_BYTES)
    out = run("udisksctl", "loop-setup", "--no-user-interaction", "-f", image)
    loop = out.rstrip(".").split()[-1]  # "Mapped file … as /dev/loop7."
    try:
        run("mkfs.vfat", "-n", "OLDSTICK", loop)
        time.sleep(1)  # let udisks2 probe the new filesystem
        print(run("udisksctl", "mount", "--no-user-interaction", "-b", loop))
        iso = os.path.join(work, "tunaos.iso")
        make_iso(iso)
        write_with_controller(loop, iso, work)

        assert subprocess.run(["findmnt", "-S", loop], capture_output=True).returncode != 0, f"{loop} still mounted"
        with open(iso, "rb") as fh:
            iso_sha = hashlib.sha256(fh.read()).hexdigest()
        with open(loop, "rb") as fh:
            written = hashlib.sha256(fh.read(ISO_BYTES)).hexdigest()
        assert written == iso_sha, (written, iso_sha)
        print(f"OK: {loop} holds the ISO (sha256 {iso_sha})")
        return 0
    finally:
        subprocess.run(["udisksctl", "unmount", "--no-user-interaction", "-b", loop], capture_output=True)
        subprocess.run(["udisksctl", "loop-delete", "--no-user-interaction", "-b", loop], capture_output=True)
        os.unlink(image)


if __name__ == "__main__":
    sys.exit(main())
