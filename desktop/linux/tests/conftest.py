import json
import os
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
# Appended: an installed copy on PYTHONPATH (CI runs the tests inside the
# Flatpak against /app/share/tunaos-media-writer) wins over the checkout.
sys.path.append(os.path.dirname(HERE))

FAKE_HELPER = os.path.join(HERE, "fake_helper.py")


def pytest_report_header(config):
    import tunaos_media_writer

    return f"tunaos_media_writer: {tunaos_media_writer.__file__}"


@pytest.fixture
def catalog_event():
    with open(os.path.join(HERE, "fixtures", "catalog.json"), encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture
def fake_env(tmp_path, monkeypatch):
    """Isolated fake helper: drive images under tmp_path, no delays."""
    monkeypatch.setenv("FAKE_HELPER_DIR", str(tmp_path / "drives"))
    monkeypatch.setenv("FAKE_HELPER_DELAY", "0")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.delenv("FAKE_HELPER_FAIL", raising=False)
    monkeypatch.delenv("FAKE_HELPER_DRIVES", raising=False)
    return tmp_path


@pytest.fixture
def run_until():
    from gi.repository import GLib

    def run(predicate, timeout=30.0):
        tick = GLib.timeout_add(20, lambda: True)
        deadline = time.monotonic() + timeout
        try:
            context = GLib.MainContext.default()
            while not predicate():
                if time.monotonic() > deadline:
                    raise AssertionError("timed out waiting for the main loop")
                context.iteration(True)
        finally:
            GLib.source_remove(tick)

    return run
