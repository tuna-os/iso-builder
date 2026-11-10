"""Controller + HelperProcess against the fake helper, on a real GLib main loop."""

import hashlib
import json
import os
import sys

import pytest

from conftest import FAKE_HELPER
from tunaos_media_writer import protocol, strings
from tunaos_media_writer.catalog import Catalog
from tunaos_media_writer.controller import Controller, merge_drives
from tunaos_media_writer.flow import DriveDestination, FileDestination, Flow, Notice, Source, Stage, Step
from tunaos_media_writer.udisks import BlockInfo, OpenFailure

HELPER = [sys.executable, FAKE_HELPER]
SOURCE = Source(label="GNOME", save_name="tunaos-yellowfin-gnome.iso", target_id="yellowfin:gnome:linux/amd64")


class FakeUDisks:
    """Stands in for udisks2: every path is known; OpenDevice opens `target`."""

    def __init__(self, target=None, hint_system=False, failure=None):
        self.target = target
        self.hint_system = hint_system
        self.failure = failure
        self.opened = []

    def watch(self, _on_changed):
        pass

    def block_for_device(self, path):
        return BlockInfo("/org/freedesktop/UDisks2/block_devices/x", self.hint_system, "Kingston", "DataTraveler")

    def open_for_writing(self, block, _cancellable, on_done):
        self.opened.append(block.object_path)
        if self.failure is not None:
            on_done(None, self.failure)
        else:
            on_done(os.open(self.target, os.O_RDWR), None)


def controller(tmp_path, udisks=None, argv=HELPER):
    flow = Flow()
    return flow, Controller(flow, argv, udisks, str(tmp_path / "work"))


def to_destination(flow, ctl, run_until):
    ctl.load_catalog()
    run_until(lambda: flow.step is not Step.LOADING)
    assert flow.step is Step.CHOOSE
    flow.choose(SOURCE)


def first_drive(ctl, run_until):
    got = []
    ctl.connect_drives(got.append)
    ctl.refresh_drives()
    run_until(lambda: got)
    return got[-1][0]


def test_catalog_loads(fake_env, run_until):
    flow, ctl = controller(fake_env)
    ctl.load_catalog()
    run_until(lambda: flow.step is not Step.LOADING)
    assert flow.step is Step.CHOOSE
    assert isinstance(flow.catalog, Catalog) and flow.catalog.default_desktop("linux/amd64") == "gnome"


def test_catalog_failure_shows_error(fake_env, run_until, monkeypatch):
    monkeypatch.setenv("FAKE_HELPER_FAIL", "catalog:network")
    flow, ctl = controller(fake_env)
    ctl.load_catalog()
    run_until(lambda: flow.step is not Step.LOADING)
    assert flow.step is Step.ERROR and flow.error.kind == "network"


def test_missing_helper_is_reported_plainly(fake_env, run_until):
    flow, ctl = controller(fake_env, argv=[str(fake_env / "nope")])
    ctl.load_catalog()
    assert flow.step is Step.ERROR
    assert (flow.error.kind, flow.error.message) == ("usage", strings.ERROR_HELPER_MISSING)


def test_save_iso_only(fake_env, run_until):
    flow, ctl = controller(fake_env)
    to_destination(flow, ctl, run_until)
    out = fake_env / "Downloads" / "x.iso"
    out.parent.mkdir()
    stages = set()
    flow.connect(lambda f: stages.add(f.stage))
    ctl.start(FileDestination(str(out)))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert flow.step is Step.DONE, flow.error
    assert flow.result.path == str(out)
    assert out.read_bytes()[32769:32774] == b"CD001"
    assert {Stage.DOWNLOADING, Stage.BUILDING} <= stages
    # Junk on stdout is logged for "Show details", not fatal.
    assert any("unexpected output" in line for line in ctl.details)
    assert any("fake-helper: building" in line for line in ctl.details)


def test_write_through_udisks_fd(fake_env, run_until):
    target = fake_env / "opened-by-udisks.img"
    target.write_bytes(b"\xff" * 4096)
    udisks = FakeUDisks(target=str(target))
    flow, ctl = controller(fake_env, udisks)
    to_destination(flow, ctl, run_until)
    choice = first_drive(ctl, run_until)
    assert choice.label == "SanDisk Ultra"
    stages = []
    flow.connect(lambda f: stages.append(f.stage))
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert flow.step is Step.DONE, (flow.error, ctl.details)
    assert flow.result.verified
    assert udisks.opened == ["/org/freedesktop/UDisks2/block_devices/x"]
    iso = (fake_env / "work" / SOURCE.save_name).read_bytes()
    assert hashlib.sha256(target.read_bytes()[: len(iso)]).digest() == hashlib.sha256(iso).digest()
    assert any("--fd 3" in line for line in ctl.details)
    assert stages.index(Stage.WAITING_PERMISSION) < stages.index(Stage.WRITING) < stages.index(Stage.VERIFYING)
    # The fake drive image itself was never touched: only the udisks fd was written.
    assert not os.path.exists(choice.drive.path)


def test_write_without_udisks_uses_helper_device(fake_env, run_until):
    flow, ctl = controller(fake_env)
    to_destination(flow, ctl, run_until)
    choice = first_drive(ctl, run_until)
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert flow.step is Step.DONE, (flow.error, ctl.details)
    assert os.path.getsize(choice.drive.path) == 2 * 1024 * 1024
    assert not any("--fd" in line for line in ctl.details)


def test_permission_refused(fake_env, run_until):
    udisks = FakeUDisks(failure=OpenFailure("permission", strings.ERROR_PERMISSION, "NotAuthorizedDismissed"))
    flow, ctl = controller(fake_env, udisks)
    to_destination(flow, ctl, run_until)
    choice = first_drive(ctl, run_until)
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert (flow.step, flow.error.kind) == (Step.ERROR, "permission")
    assert "NotAuthorizedDismissed" in ctl.details


def test_cancel_during_build(fake_env, run_until, monkeypatch):
    monkeypatch.setenv("FAKE_HELPER_DELAY", "0.2")
    flow, ctl = controller(fake_env)
    to_destination(flow, ctl, run_until)
    choice = first_drive(ctl, run_until)
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.stage is Stage.DOWNLOADING)
    ctl.cancel()
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert flow.step is Step.DESTINATION
    assert flow.take_notice() is Notice.CANCELLED
    assert not os.path.exists(ctl.iso_path_for(SOURCE))
    assert any("[exit 130]" in line for line in ctl.details)


def test_build_error_then_write_retry_reuses_iso(fake_env, run_until, monkeypatch):
    monkeypatch.setenv("FAKE_HELPER_FAIL", "write:verify-mismatch")
    flow, ctl = controller(fake_env)
    to_destination(flow, ctl, run_until)
    choice = first_drive(ctl, run_until)
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert (flow.step, flow.error.kind) == (Step.ERROR, "verify-mismatch")
    assert os.path.exists(ctl.iso_path_for(SOURCE))

    monkeypatch.delenv("FAKE_HELPER_FAIL")
    flow.retry()
    ctl.start(DriveDestination(choice.drive, choice.label))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert flow.step is Step.DONE
    assert any(line.startswith("reusing ") for line in ctl.details)
    assert not any("--target" in line for line in ctl.details)
    ctl.shutdown()
    assert not os.path.exists(ctl.iso_path_for(SOURCE))


def test_build_failure(fake_env, run_until, monkeypatch):
    monkeypatch.setenv("FAKE_HELPER_FAIL", "build:storage")
    flow, ctl = controller(fake_env)
    to_destination(flow, ctl, run_until)
    ctl.start(FileDestination(str(fake_env / "x.iso")))
    run_until(lambda: flow.step is not Step.PROGRESS)
    assert (flow.step, flow.error.kind) == (Step.ERROR, "storage")
    assert "9 GB" in flow.error.message
    assert not (fake_env / "x.iso").exists()


def test_drives_from_file_and_hotplug_refresh(fake_env, run_until, monkeypatch):
    drives_file = fake_env / "drives.json"
    drives_file.write_text(json.dumps({"drives": []}))
    monkeypatch.setenv("FAKE_HELPER_DRIVES", str(drives_file))
    flow, ctl = controller(fake_env)
    seen = []
    ctl.connect_drives(seen.append)
    ctl.refresh_drives()
    run_until(lambda: ctl._drives_proc is None)
    assert seen == []  # unchanged empty list: no notification
    drives_file.write_text(json.dumps({"drives": [
        {"id": "usb-9", "path": "/dev/sdz", "name": "", "sizeBytes": 8, "bus": "usb", "systemDisk": False}
    ]}))
    ctl.refresh_drives()
    run_until(lambda: seen)
    assert [c.label for c in seen[-1]] == [strings.DRIVE_FALLBACK_NAME]


@pytest.mark.parametrize(
    "drive_id,block,expected",
    [
        ("usb-1", BlockInfo("/b", False, "Kingston", "DT"), ["Kingston DT"]),
        ("usb-1", BlockInfo("/b", True, "", ""), []),  # udisks2 says system device
        ("usb-1", None, []),  # udisks2 does not know it: cannot be opened
    ],
)
def test_merge_drives(drive_id, block, expected):
    drive = protocol.Drive(drive_id, "/dev/sdb", "", 8, "usb", True)
    assert [c.label for c in merge_drives([drive], lambda _p: block)] == expected


def test_merge_drives_offers_named_test_devices_despite_system_hint():
    loop = protocol.Drive("/dev/loop5|8|test", "/dev/loop5", "", 8, "other", True)
    flagged = BlockInfo("/b", True, "", "")
    assert merge_drives([loop], lambda _p: flagged) == []
    assert [c.label for c in merge_drives([loop], lambda _p: flagged, frozenset({"/dev/loop5"}))] == ["USB drive"]


def test_merge_drives_never_offers_system_disks():
    drive = protocol.Drive("usb-1", "/dev/sda", "Disk", 8, "usb", True, system_disk=True)
    assert merge_drives([drive], None) == []
