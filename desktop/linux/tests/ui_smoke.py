#!/usr/bin/env python3
"""UI smoke run: walks all four steps against the fake helper and saves a PNG
of the window at each one. Needs a display (CI: xvfb-run + dbus-run-session).

    python3 tests/ui_smoke.py --out screenshots/

Run inside the Flatpak to test the installed code instead of the checkout:
    flatpak run --filesystem=$PWD --env=PYTHONPATH=/app/share/tunaos-media-writer \
        --command=python3 org.tunaos.MediaWriter tests/ui_smoke.py --out $PWD/screenshots
"""

import argparse
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# Appended, so an installed copy on PYTHONPATH wins over the checkout.
sys.path.append(os.path.dirname(HERE))

os.environ.setdefault("GSK_RENDERER", "cairo")
os.environ["FAKE_HELPER_DELAY"] = "0.05"
os.environ["FAKE_HELPER_ISO_BYTES"] = str(8 * 1024 * 1024)
os.environ["FAKE_HELPER_DIR"] = tempfile.mkdtemp(prefix="mw-smoke-drives-")
os.environ.pop("FAKE_HELPER_FAIL", None)

import tunaos_media_writer  # noqa: E402
from tunaos_media_writer.app import Application  # noqa: E402
from tunaos_media_writer.flow import Stage, Step  # noqa: E402
from tunaos_media_writer.window import Gtk  # noqa: E402

from gi.repository import GLib, Graphene  # noqa: E402

TIMEOUT = 60


def capture(window: Gtk.Window, path: str) -> None:
    width, height = window.get_width(), window.get_height()
    paintable = Gtk.WidgetPaintable.new(window)
    snapshot = Gtk.Snapshot()
    paintable.snapshot(snapshot, width, height)
    node = snapshot.to_node()
    texture = window.get_native().get_renderer().render_texture(node, Graphene.Rect().init(0, 0, width, height))
    texture.save_to_png(path)
    print(f"screenshot {path} ({width}x{height})", flush=True)


def scenario(app: Application, out: str):
    win = app.window
    flow = win.flow
    shot = lambda name: capture(win, os.path.join(out, name + ".png"))  # noqa: E731

    yield lambda: flow.step is Step.CHOOSE
    assert win.selected_desktop() == "gnome", win.selected_desktop()
    shot("1-choose")
    win.continue_button.emit("clicked")

    yield lambda: flow.step is Step.DESTINATION and win.controller.drives
    shot("2-destination")
    win.confirm_erase(win.controller.drives[0])
    yield None
    shot("2-confirm-erase")
    dialog = win.confirm_dialog
    dialog.emit("response", "erase")
    dialog.force_close()

    yield lambda: flow.stage is Stage.BUILDING and (flow.fraction or 0) > 0.3
    shot("3-progress-building")
    win.close()  # asks first while working
    yield None
    shot("3-quit-confirm")
    win.quit_dialog.emit("response", "keep")
    win.quit_dialog.force_close()
    assert flow.step is Step.PROGRESS
    yield lambda: flow.stage is Stage.WRITING and (flow.fraction or 0) > 0.3
    shot("3-progress-writing")
    yield lambda: flow.step is Step.DONE
    assert flow.result.verified
    shot("4-done-usb")

    # Error path: the build fails with a network error.
    os.environ["FAKE_HELPER_FAIL"] = "build:network"
    flow.start_over()
    win.select_desktop("kde")
    win.continue_button.emit("clicked")
    yield lambda: flow.step is Step.DESTINATION
    iso = os.path.join(tempfile.mkdtemp(prefix="mw-smoke-out-"), "tunaos.iso")
    win.save_to(iso)
    yield lambda: flow.step is Step.ERROR
    shot("5-error")
    win.show_details()
    yield None
    shot("5-error-details")
    win.details_dialog.force_close()

    # "Try again" then save the ISO file only.
    del os.environ["FAKE_HELPER_FAIL"]
    flow.retry()
    yield lambda: flow.step is Step.DESTINATION
    win.save_to(iso)
    yield lambda: flow.step is Step.DONE
    assert os.path.getsize(iso) == 8 * 1024 * 1024
    shot("4-done-file")
    app.quit()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    print(f"testing {tunaos_media_writer.__file__}", flush=True)

    app = Application()
    state = {"steps": None, "wait": None, "since": 0.0, "deadline": 0.0, "failed": None}

    def tick() -> bool:
        if app.window is None:
            return GLib.SOURCE_CONTINUE
        if state["steps"] is None:
            Gtk.Settings.get_default().set_property("gtk-enable-animations", False)
            state["steps"] = scenario(app, out)
            state["deadline"] = time.monotonic() + TIMEOUT
        now = time.monotonic()
        try:
            wait = state["wait"]
            if wait is not None and not wait():
                if now > state["deadline"]:
                    raise AssertionError(f"timed out on step {app.window.flow.step} stage {app.window.flow.stage}")
                return GLib.SOURCE_CONTINUE
            # Let a frame or two render before the next screenshot.
            if now - state["since"] < 0.4:
                return GLib.SOURCE_CONTINUE
            state["wait"] = next(state["steps"]) or (lambda: True)
            state["since"] = time.monotonic()
            state["deadline"] = state["since"] + TIMEOUT
        except StopIteration:
            return GLib.SOURCE_REMOVE
        except Exception as exc:  # noqa: BLE001 - report and exit non-zero
            import traceback

            traceback.print_exc()
            state["failed"] = exc
            app.quit()
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE

    GLib.timeout_add(50, tick)
    helper = os.path.join(HERE, "fake_helper.py")
    status = app.run([sys.argv[0], "--fake-helper", helper])
    if state["failed"] is not None:
        return 1
    expected = {"1-choose", "2-destination", "2-confirm-erase", "3-progress-building", "3-quit-confirm",
                "3-progress-writing",
                "4-done-usb", "5-error", "5-error-details", "4-done-file"}
    missing = expected - {os.path.splitext(f)[0] for f in os.listdir(out)}
    if missing:
        print(f"missing screenshots: {sorted(missing)}", file=sys.stderr)
        return 1
    return status


if __name__ == "__main__":
    sys.exit(main())
