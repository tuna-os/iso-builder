import pytest

from tunaos_media_writer import protocol
from tunaos_media_writer.catalog import Catalog
from tunaos_media_writer.flow import (
    DriveDestination,
    FileDestination,
    Flow,
    InvalidTransition,
    Notice,
    Source,
    Stage,
    Step,
    stage_for_phase,
)

DRIVE = protocol.Drive("usb-1", "/dev/sdb", "Stick", 16_000_000_000, "usb", True)
SOURCE = Source(label="GNOME on Kitten", save_name="tunaos-yellowfin-gnome.iso", target_id="yellowfin:gnome:linux/amd64")


def at_destination():
    flow = Flow()
    flow.catalog_loaded(Catalog([], [], []))
    flow.choose(SOURCE)
    return flow


def progress(phase, current=1, total=2):
    return protocol.Progress(phase, current, total)


def test_happy_path_to_usb():
    flow = Flow()
    seen = []
    flow.connect(lambda f: seen.append((f.step, f.stage)))
    flow.catalog_loaded(Catalog([], [], []))
    flow.choose(SOURCE)
    flow.start(DriveDestination(DRIVE, "Stick"))
    assert (flow.step, flow.stage) == (Step.PROGRESS, Stage.PREPARING)
    flow.on_progress(progress("download"))
    assert flow.stage is Stage.DOWNLOADING and flow.fraction == 0.5
    flow.on_progress(progress("erofs", 1, 0))
    assert flow.stage is Stage.BUILDING and flow.fraction is None
    flow.build_done(protocol.Done(path="/c/x.iso"))
    assert (flow.step, flow.stage) == (Step.PROGRESS, Stage.WAITING_PERMISSION)
    flow.write_started()
    flow.on_progress(progress("write", 3, 4))
    assert flow.stage is Stage.WRITING and flow.fraction == 0.75
    flow.on_progress(progress("verify"))
    assert flow.stage is Stage.VERIFYING
    flow.write_done(protocol.Done(device="/dev/sdb", verified=True))
    assert flow.step is Step.DONE and flow.result.verified
    assert seen[0] == (Step.CHOOSE, Stage.PREPARING) and seen[-1][0] is Step.DONE
    flow.start_over()
    assert flow.step is Step.CHOOSE and flow.source is None


def test_save_iso_only_finishes_after_build():
    flow = at_destination()
    flow.start(FileDestination("/home/u/Downloads/x.iso"))
    flow.build_done(protocol.Done(path="/home/u/Downloads/x.iso"))
    assert flow.step is Step.DONE and not flow.writes_drive


def test_back_from_destination():
    flow = at_destination()
    flow.back()
    assert flow.step is Step.CHOOSE and flow.source is SOURCE


def test_cancel_returns_to_destination_with_notice_and_ignores_late_events():
    flow = at_destination()
    flow.start(DriveDestination(DRIVE, "Stick"))
    flow.cancel()
    flow.on_progress(progress("download"))
    flow.build_done(protocol.Done(path="/x"))
    assert flow.stage is Stage.CANCELLING
    flow.fail("cancelled", "")
    assert flow.step is Step.DESTINATION and flow.destination is None
    assert flow.take_notice() is Notice.CANCELLED
    assert flow.take_notice() is None


def test_error_and_retry_targets():
    flow = Flow()
    flow.fail("network", "offline")
    assert flow.step is Step.ERROR and flow.error == protocol.Error("network", "offline")
    flow.retry()
    assert flow.step is Step.LOADING

    flow = at_destination()
    flow.start(DriveDestination(DRIVE, "Stick"))
    flow.fail("verify-mismatch", "mismatch")
    flow.retry()
    assert flow.step is Step.DESTINATION and flow.source is SOURCE and flow.error is None


@pytest.mark.parametrize(
    "action",
    [
        lambda f: f.choose(SOURCE),
        lambda f: f.back(),
        lambda f: f.start(FileDestination("/x")),
        lambda f: f.on_progress(progress("download")),
        lambda f: f.cancel(),
        lambda f: f.retry(),
        lambda f: f.start_over(),
    ],
)
def test_invalid_transitions_while_loading(action):
    with pytest.raises(InvalidTransition):
        action(Flow())


def test_stage_for_phase():
    assert stage_for_phase("download") is Stage.DOWNLOADING
    for phase in ("unpack", "overlay", "erofs", "esp", "iso", "something-new"):
        assert stage_for_phase(phase) is Stage.BUILDING
    assert stage_for_phase("write") is Stage.WRITING
    assert stage_for_phase("verify") is Stage.VERIFYING


def test_source_from_target_and_request(tmp_path):
    catalog = Catalog.from_event(
        {
            "desktops": [{"id": "gnome", "label": "GNOME"}],
            "bases": [{"id": "yellowfin", "label": "AlmaLinux Kitten 10"}],
            "targets": [{"id": "t", "base": "yellowfin", "desktop": "gnome", "platform": "linux/amd64"}],
        }
    )
    source = Source.from_target(catalog, catalog.targets[0])
    assert source.label == "GNOME on AlmaLinux Kitten 10"
    assert source.build_args() == ["--target", "t"]
    assert source.save_name == "tunaos-yellowfin-gnome.iso"

    path = str(tmp_path / "build-request.json")
    request = Source.from_request(
        path, {"schemaVersion": 1, "image": "ghcr.io/tuna-os/yellowfin:gnome",
               "options": {"label": "My TunaOS", "outputFilename": "../evil/my.iso"}}
    )
    assert request.build_args() == ["--request", path]
    assert (request.label, request.save_name) == ("My TunaOS", "my.iso")
    plain = Source.from_request(path, {"schemaVersion": 1, "image": "x"})
    assert (plain.label, plain.save_name) == ("build-request.json", "build-request.iso")
    for bad in ({}, [], {"schemaVersion": 2, "image": "x"}, {"schemaVersion": 1, "image": ""}):
        with pytest.raises(ValueError):
            Source.from_request(path, bad)
