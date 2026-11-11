import pytest

from tunaos_media_writer import protocol
from tunaos_media_writer.protocol import parse_event


def test_progress_with_known_total():
    event = parse_event('{"event":"progress","phase":"download","current":50,"total":200,"unit":"bytes","message":"x"}')
    assert event == protocol.Progress("download", 50, 200, "bytes", "x")
    assert event.fraction == 0.25


def test_progress_unknown_total_pulses_and_fraction_is_clamped():
    assert parse_event('{"event":"progress","phase":"iso","current":5,"total":0}').fraction is None
    assert parse_event('{"event":"progress","phase":"iso","current":9,"total":3}').fraction == 1.0


def test_log_error_version():
    assert parse_event('{"event":"log","level":"warn","message":"offline"}') == protocol.Log("warn", "offline")
    assert parse_event('{"event":"error","kind":"network","message":"No internet."}') == protocol.Error(
        "network", "No internet."
    )
    assert parse_event('{"event":"version","helper":"1.2.3","engine":"v0","protocol":1}') == protocol.Version(
        "1.2.3", "v0", 1
    )


def test_drives_skip_malformed_entries_and_default_to_system_disk_when_unsure():
    event = parse_event(
        '{"event":"drives","drives":['
        '{"id":"usb-1","path":"/dev/sdb","name":"Stick","sizeBytes":16000000000,"bus":"usb",'
        '"removable":true,"mounted":["/run/media/a"],"systemDisk":false},'
        '{"id":"usb-2","path":"/dev/sdc","sizeBytes":1},'
        '{"path":"/dev/sdd"}, 7]}'
    )
    first, second = event.drives
    assert first == protocol.Drive("usb-1", "/dev/sdb", "Stick", 16000000000, "usb", True, ("/run/media/a",), False)
    assert second.system_disk is True  # systemDisk missing: never trust it
    assert second.bus == "other"


def test_done_for_build_and_write():
    build = parse_event('{"event":"done","path":"/tmp/a.iso","bytes":10,"sha256":"ab"}')
    assert (build.path, build.bytes, build.sha256, build.verified) == ("/tmp/a.iso", 10, "ab", False)
    write = parse_event('{"event":"done","device":"/dev/sdb","bytes":10,"verified":true}')
    assert (write.device, write.verified) == ("/dev/sdb", True)


def test_unknown_events_and_fields_are_ignored():
    assert parse_event('{"event":"telemetry","x":1}') is None
    assert parse_event('{"event":"log","level":"info","message":"m","newField":[1]}') == protocol.Log("info", "m")
    assert parse_event("   \n") is None


def test_catalog_event_keeps_payload():
    event = parse_event('{"event":"catalog","defaultTarget":"a","desktops":[]}')
    assert event.data["defaultTarget"] == "a"


def test_wrong_types_fall_back_to_defaults():
    event = parse_event('{"event":"progress","phase":3,"current":"many","total":true}')
    assert event == protocol.Progress("", 0, 0, "", "")


@pytest.mark.parametrize("line", ["not json", "[1,2]", '{"no":"event"}', '{"event":5}'])
def test_non_events_raise(line):
    with pytest.raises(protocol.ProtocolError):
        parse_event(line)


def test_bytes_with_invalid_utf8():
    event = parse_event(b'{"event":"log","level":"info","message":"caf\xff"}')
    assert event.message == "caf\ufffd"
