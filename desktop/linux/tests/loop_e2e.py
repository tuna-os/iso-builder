#!/usr/bin/env python3
"""Write path end to end on a udisks2 loop device — never a real disk.

Creates a file-backed loop device through udisks2, puts a mounted FAT
filesystem on it, then runs the app's Controller write step for real:
udisks2 Filesystem.Unmount → Block.OpenDevice("rw", O_EXCL) → fd passed to
`<helper> write --fd 3` → done event with verified=true, and checks the
bytes on the loop device against the ISO.

Needs udisks2 and polkit authorization for loop-setup/mount/open-device
(run as root, or from an active desktop session that can answer the prompt).

    sudo python3 tests/loop_e2e.py                       # fake helper
    sudo TUNAOS_MEDIA_HELPER=/path/tunaos-media-helper python3 tests/loop_e2e.py
      (a helper built with `-tags testdevices`; the script sets
       TUNAOS_MEDIA_HELPER_TEST_DEVICES to the loop device)
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from gi.repository import GLib  # noqa: E402

from tunaos_media_writer import protocol  # noqa: E402
from tunaos_media_writer.catalog import Catalog  # noqa: E402
from tunaos_media_writer.controller import Controller  # noqa: E402
from tunaos_media_writer.flow import DriveDestination, Flow, Source, Step  # noqa: E402
from tunaos_media_writer.udisks import UDisks  # noqa: E402

ISO_BYTES = 24 * 1024 * 1024
IMAGE_BYTES = 64 * 1024 * 1024


def run(*argv: str) -> str:
    print("+", " ".join(argv), flush=True)
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
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
        data = bytearray(os.urandom(ISO_BYTES))
        data[32769:32774] = b"CD001"
        with open(iso, "wb") as fh:
            fh.write(data)
        iso_sha = hashlib.sha256(data).hexdigest()

        helper = os.environ.get("TUNAOS_MEDIA_HELPER")
        if helper:
            argv = [helper]
            os.environ["TUNAOS_MEDIA_HELPER_TEST_DEVICES"] = loop
        else:
            argv = [sys.executable, os.path.join(HERE, "fake_helper.py")]
            drives_file = os.path.join(work, "drives.json")
            with open(drives_file, "w") as fh:
                json.dump({"drives": [{"id": f"test:{loop}", "path": loop, "name": "", "sizeBytes": IMAGE_BYTES,
                                       "bus": "other", "removable": True, "systemDisk": False}]}, fh)
            os.environ["FAKE_HELPER_DRIVES"] = drives_file

        udisks = UDisks.connect()
        assert udisks is not None, "udisks2 is required"
        flow = Flow()
        controller = Controller(flow, argv, udisks, os.path.join(work, "cache"))

        # Step 2 for real: the helper's drive list, merged with udisks2.
        listed = []
        controller.connect_drives(listed.append)
        controller.refresh_drives()
        context = GLib.MainContext.default()
        deadline = time.monotonic() + 30
        while not listed and time.monotonic() < deadline:
            context.iteration(False)
            time.sleep(0.01)
        choice = next((c for c in (listed[-1] if listed else []) if c.drive.path == loop), None)
        assert choice is not None, f"{loop} not offered: {listed} {controller.details}"
        print(f"offered: {choice.label} {choice.drive}")

        flow.catalog_loaded(Catalog([], [], []))
        source = Source(label="loop e2e", save_name="tunaos.iso", target_id="loop-e2e")
        flow.choose(source)
        # The ISO is already built: start() reuses it and goes straight to writing.
        controller._built = (source.key, iso)
        controller.start(DriveDestination(choice.drive, choice.label))
        deadline = time.monotonic() + 120
        while flow.step is Step.PROGRESS and time.monotonic() < deadline:
            context.iteration(False)
            time.sleep(0.005)
        print("\n".join(controller.details))
        assert flow.step is Step.DONE, f"ended at {flow.step}: {flow.error}"
        assert isinstance(flow.result, protocol.Done) and flow.result.verified, flow.result

        mounts = run("findmnt", "-n", "-o", "TARGET", "-S", loop) if subprocess.run(
            ["findmnt", "-S", loop], capture_output=True).returncode == 0 else ""
        assert not mounts, f"{loop} still mounted at {mounts}"
        with open(loop, "rb") as fh:
            written = hashlib.sha256(fh.read(ISO_BYTES)).hexdigest()
        assert written == iso_sha, (written, iso_sha)
        print(f"OK: {loop} holds the ISO (sha256 {iso_sha}), verified={flow.result.verified}")
        return 0
    finally:
        subprocess.run(["udisksctl", "unmount", "--no-user-interaction", "-b", loop], capture_output=True)
        subprocess.run(["udisksctl", "loop-delete", "--no-user-interaction", "-b", loop], capture_output=True)
        os.unlink(image)


if __name__ == "__main__":
    sys.exit(main())
