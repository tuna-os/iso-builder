"""Application entry point."""

from __future__ import annotations

import os
import sys

from gi.repository import Gio, GLib

from . import APP_ID, VERSION, strings
from .controller import Controller
from .flow import Flow
from .helper import HelperMissing, find_helper
from .udisks import UDisks
from .window import Adw, MainWindow, about, install_css


def work_dir() -> str:
    """Where the ISO for a USB write is built; inside the Flatpak this is
    ~/.var/app/org.tunaos.MediaWriter/cache."""
    return os.path.join(GLib.get_user_cache_dir(), "tunaos-media-writer")


class Application(Adw.Application):
    def __init__(self) -> None:
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        GLib.set_application_name(strings.APP_NAME)
        self.add_main_option(
            "fake-helper", 0, GLib.OptionFlags.NONE, GLib.OptionArg.FILENAME,
            "Test mode: run this executable instead of tunaos-media-helper and skip udisks2", "PATH",
        )
        self.add_main_option(
            "base-url", 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING,
            "Catalog base URL passed to the helper (default: the helper's)", "URL",
        )
        self.fake_helper: str | None = None
        self.base_url: str | None = None
        self.window: MainWindow | None = None
        self.controller: Controller | None = None

    def do_handle_local_options(self, options: GLib.VariantDict) -> int:
        fake = options.lookup_value("fake-helper", None)
        if fake is not None:
            self.fake_helper = os.path.abspath(fake.get_bytestring().decode())
        base = options.lookup_value("base-url", None)
        if base is not None:
            self.base_url = base.get_string()
        return -1

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)
        install_css()
        action = Gio.SimpleAction.new("about", None)
        action.connect("activate", lambda *_: about(self.get_active_window(), VERSION))
        self.add_action(action)
        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *_: self.quit())
        self.add_action(quit_action)
        self.set_accels_for_action("app.quit", ["<Control>q"])

    def do_activate(self) -> None:
        if self.window is not None:
            self.window.present()
            return
        flow = Flow()
        if self.fake_helper:
            argv, udisks = [self.fake_helper], None
        else:
            try:
                argv = [find_helper()]
            except HelperMissing:
                argv = ["tunaos-media-helper"]  # spawning fails → "installation is incomplete"
            udisks = UDisks.connect()
        self.controller = Controller(flow, argv, udisks, work_dir(), self.base_url)
        self.window = MainWindow(self, flow, self.controller)
        self.window.present()

    def do_shutdown(self) -> None:
        if self.controller is not None:
            self.controller.shutdown()
        Adw.Application.do_shutdown(self)


def main(argv: list[str] | None = None) -> int:
    return Application().run(sys.argv if argv is None else argv)
