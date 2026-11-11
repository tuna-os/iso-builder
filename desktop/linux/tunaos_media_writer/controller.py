"""Runs helper subcommands and udisks2 calls and feeds the results into the
Flow. The window only calls the public methods here and renders Flow."""

from __future__ import annotations

import os
import shlex
import signal
from dataclasses import dataclass
from typing import Callable

from gi.repository import Gio, GLib

from . import protocol, strings
from .catalog import Catalog
from .flow import DriveDestination, FileDestination, Flow, Source, Stage, Step
from .helper import DEVICE_FD, HelperProcess
from .udisks import BlockInfo, UDisks

DRIVE_POLL_SECONDS = 2
_HOTPLUG_SETTLE_MS = 300
# Honoured by helpers built with `-tags testdevices` only (release helpers
# ignore it and never list loop devices); see tests/loop_e2e.py.
TEST_DEVICES_ENV = "TUNAOS_MEDIA_HELPER_TEST_DEVICES"


def test_device_paths() -> frozenset[str]:
    return frozenset(p for p in os.environ.get(TEST_DEVICES_ENV, "").split(",") if p)


@dataclass(frozen=True)
class DriveChoice:
    drive: protocol.Drive
    label: str

    @property
    def size_bytes(self) -> int:
        return self.drive.size_bytes


def drive_label(drive: protocol.Drive, block: BlockInfo | None) -> str:
    if drive.name.strip():
        return drive.name.strip()
    if block is not None and block.display_name:
        return block.display_name
    return strings.DRIVE_FALLBACK_NAME


def merge_drives(
    drives,
    lookup: Callable[[str], BlockInfo | None] | None,
    test_paths: frozenset[str] = frozenset(),
) -> list[DriveChoice]:
    """The helper's safety-filtered list, cross-checked against udisks2.

    With udisks2 (lookup given) a drive is only offered when udisks2 knows
    its block device (that is how it gets opened) and does not flag it as a
    system device — except the file-backed test devices named in
    TEST_DEVICES_ENV, which udisks2 always flags as system (loop devices).
    """
    choices = []
    for drive in drives:
        if drive.system_disk:
            continue
        block = None
        if lookup is not None:
            block = lookup(drive.path)
            if block is None or (block.hint_system and drive.path not in test_paths):
                continue
        choices.append(DriveChoice(drive, drive_label(drive, block)))
    return choices


class Controller:
    def __init__(
        self,
        flow: Flow,
        helper_argv: list[str],
        udisks: UDisks | None,
        work_dir: str,
        base_url: str | None = None,
    ) -> None:
        self.flow = flow
        self._helper_argv = helper_argv
        self._udisks = udisks
        self._work_dir = work_dir
        self._base_url = base_url
        self.drives: list[DriveChoice] = []
        self.details: list[str] = []
        self._drive_listeners: list[Callable[[list[DriveChoice]], None]] = []
        self._drives_proc: HelperProcess | None = None
        self._drives_dirty = False
        self._watching = False
        self._poll_id = 0
        self._settle_id = 0
        self._job: HelperProcess | None = None
        self._open_cancellable: Gio.Cancellable | None = None
        self._built: tuple[str, str] | None = None  # (source key, iso path) kept for "Try again"
        if udisks is not None:
            udisks.watch(self._hotplug)

    # -- plumbing ----------------------------------------------------
    def _spawn(self, args, on_event, on_exit, pass_fd=None) -> HelperProcess | None:
        proc = HelperProcess(self._helper_argv + args, on_event, on_exit, pass_fd)
        try:
            proc.start()
        except GLib.Error as exc:
            if pass_fd is not None:
                os.close(pass_fd)
            self.details.append(f"$ {shlex.join(self._helper_argv + args)}\n{exc.message}")
            self.flow.fail("usage", strings.ERROR_HELPER_MISSING)
            return None
        return proc

    def _fail_from(self, proc: HelperProcess, error: protocol.Error | None, code: int) -> None:
        self.details.extend(proc.log)
        if code == protocol.EXIT_CANCELLED or (error is not None and error.kind == "cancelled"):
            self.flow.fail("cancelled", "")
        elif error is not None:
            self.flow.fail(error.kind, error.message)
        else:
            self.flow.fail("engine", strings.ERROR_HELPER_CRASHED)

    # -- step 1: catalog ---------------------------------------------
    def load_catalog(self) -> None:
        state: dict = {}

        def on_event(event):
            if isinstance(event, protocol.CatalogEvent):
                state["catalog"] = Catalog.from_event(event.data)
            elif isinstance(event, protocol.Error):
                state["error"] = event

        def on_exit(code):
            if code == protocol.EXIT_OK and "catalog" in state:
                self.flow.catalog_loaded(state["catalog"])
            else:
                self._fail_from(proc, state.get("error"), code)

        args = ["catalog"] + (["--base-url", self._base_url] if self._base_url else [])
        proc = self._spawn(args, on_event, on_exit)

    # -- step 2: drives ----------------------------------------------
    def connect_drives(self, listener: Callable[[list[DriveChoice]], None]) -> None:
        self._drive_listeners.append(listener)

    def watch_drives(self, active: bool) -> None:
        """Refresh while the destination step is visible: on udisks2 hotplug
        signals, and every DRIVE_POLL_SECONDS as a fallback."""
        if active == self._watching:
            return
        self._watching = active
        if active:
            self.refresh_drives()
            self._poll_id = GLib.timeout_add_seconds(DRIVE_POLL_SECONDS, self._poll)
        elif self._poll_id:
            GLib.source_remove(self._poll_id)
            self._poll_id = 0

    def _poll(self) -> bool:
        self.refresh_drives()
        return GLib.SOURCE_CONTINUE

    def _hotplug(self) -> None:
        if self._watching and not self._settle_id:
            self._settle_id = GLib.timeout_add(_HOTPLUG_SETTLE_MS, self._settled)

    def _settled(self) -> bool:
        self._settle_id = 0
        self.refresh_drives()
        return GLib.SOURCE_REMOVE

    def refresh_drives(self) -> None:
        if self._drives_proc is not None and self._drives_proc.running:
            self._drives_dirty = True
            return
        state: dict = {}

        def on_event(event):
            if isinstance(event, protocol.Drives):
                state["drives"] = event.drives

        def on_exit(code):
            self._drives_proc = None
            if code == protocol.EXIT_OK and "drives" in state:
                lookup = self._udisks.block_for_device if self._udisks is not None else None
                drives = merge_drives(state["drives"], lookup, test_device_paths())
                if drives != self.drives:
                    self.drives = drives
                    for listener in list(self._drive_listeners):
                        listener(drives)
            else:
                self.details.extend(proc.log[-20:])
            if self._drives_dirty:
                self._drives_dirty = False
                self.refresh_drives()

        os.makedirs(self._work_dir, exist_ok=True)
        proc = HelperProcess(self._helper_argv + ["drives", "--exclude", self._work_dir], on_event, on_exit)
        try:
            proc.start()
        except GLib.Error as exc:
            self.details.append(exc.message)
            return
        self._drives_proc = proc

    # -- step 3: build, then write -----------------------------------
    def iso_path_for(self, source: Source) -> str:
        return os.path.join(self._work_dir, source.save_name)

    def start(self, destination: DriveDestination | FileDestination) -> None:
        self.details.clear()
        self.flow.start(destination)
        source = self.flow.source
        if isinstance(destination, FileDestination):
            self._build(destination.path)
            return
        if self._built and self._built[0] == source.key and os.path.exists(self._built[1]):
            self.details.append(f"reusing {self._built[1]}")
            self.flow.build_done(protocol.Done(path=self._built[1]))
            self._prepare_write(self._built[1])
            return
        self.discard_build()
        os.makedirs(self._work_dir, exist_ok=True)
        self._build(self.iso_path_for(source))

    def _build(self, out: str) -> None:
        state: dict = {}

        def on_event(event):
            if isinstance(event, protocol.Progress):
                self.flow.on_progress(event)
            elif isinstance(event, protocol.Done):
                state["done"] = event
            elif isinstance(event, protocol.Error):
                state["error"] = event

        def on_exit(code):
            self._job = None
            if self.flow.stage is Stage.CANCELLING:
                self._remove(out)
                self.details.extend(proc.log)
                self.flow.cancelled()
                return
            if code != protocol.EXIT_OK or "done" not in state:
                self._remove(out)
                self._fail_from(proc, state.get("error"), code)
                return
            self.details.extend(proc.log)
            done = state["done"]
            iso = done.path or out
            if self.flow.writes_drive:
                self._built = (self.flow.source.key, iso)
            self.flow.build_done(done)
            if self.flow.writes_drive:
                self._prepare_write(iso)

        args = ["build", *self.flow.source.build_args(), "--out", out]
        proc = self._spawn(args, on_event, on_exit)
        self._job = proc

    def _prepare_write(self, iso: str) -> None:
        drive = self.flow.destination.drive
        if self._udisks is None:
            # No udisks2 (the --fake-helper test mode): the helper opens the
            # device itself, which it can only do outside the sandbox.
            self._write(iso, None)
            return
        block = self._udisks.block_for_device(drive.path)
        if block is None:
            self.flow.fail("device-changed", strings.ERROR_DRIVE_GONE)
            return
        self._open_cancellable = Gio.Cancellable()

        def opened(fd, failure):
            self._open_cancellable = None
            if self.flow.stage is Stage.CANCELLING or (failure and failure.kind == "cancelled"):
                if fd is not None:
                    os.close(fd)
                self.flow.cancelled()
                return
            if failure is not None:
                self.details.append(failure.detail)
                self.flow.fail(failure.kind, failure.message)
                return
            self._write(iso, fd)

        self._udisks.open_for_writing(block, self._open_cancellable, opened)

    def _write(self, iso: str, fd: int | None) -> None:
        state: dict = {}
        self.flow.write_started()

        def on_event(event):
            if isinstance(event, protocol.Progress):
                self.flow.on_progress(event)
            elif isinstance(event, protocol.Done):
                state["done"] = event
            elif isinstance(event, protocol.Error):
                state["error"] = event

        def on_exit(code):
            self._job = None
            self.details.extend(proc.log)
            if self.flow.stage is Stage.CANCELLING:
                self.flow.cancelled()
            elif code == protocol.EXIT_OK and "done" in state:
                self.flow.write_done(state["done"])
            else:
                self._fail_from(proc, state.get("error"), code)

        args = ["write", "--iso", iso, "--device", self.flow.destination.drive.id]
        if fd is not None:
            args += ["--fd", str(DEVICE_FD)]
        proc = self._spawn(args, on_event, on_exit, pass_fd=fd)
        self._job = proc

    def cancel(self) -> None:
        if self.flow.step is not Step.PROGRESS or self.flow.stage is Stage.CANCELLING:
            return
        self.flow.cancel()
        if self._job is not None:
            self._job.signal(signal.SIGTERM)
        elif self._open_cancellable is not None:
            self._open_cancellable.cancel()

    # -- cleanup -----------------------------------------------------
    @staticmethod
    def _remove(path: str) -> None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def discard_build(self) -> None:
        if self._built is not None:
            self._remove(self._built[1])
            self._built = None

    def shutdown(self) -> None:
        self.watch_drives(False)
        if self._job is not None:
            self._job.signal(signal.SIGTERM)
        self.discard_build()
