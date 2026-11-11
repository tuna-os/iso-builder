"""Spawning tunaos-media-helper with Gio.Subprocess and reading its events."""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import sys
from typing import Callable

from gi.repository import Gio, GLib

from . import protocol

HELPER_NAME = "tunaos-media-helper"
HELPER_ENV = "TUNAOS_MEDIA_HELPER"
# The fd number the helper sees for the device opened through udisks2.
DEVICE_FD = 3
_READ_SIZE = 64 * 1024


class HelperMissing(RuntimeError):
    pass


def find_helper() -> str:
    """The bundled helper: $TUNAOS_MEDIA_HELPER, else /app/bin (Flatpak) or $PATH."""
    override = os.environ.get(HELPER_ENV)
    if override:
        return override
    for candidate in ("/app/bin/" + HELPER_NAME, shutil.which(HELPER_NAME)):
        if candidate and os.access(candidate, os.X_OK):
            return candidate
    raise HelperMissing(HELPER_NAME)


class HelperProcess:
    """One helper invocation.

    on_event(event) runs on the main loop for every parsed event, in order;
    on_exit(code) runs exactly once after stdout is drained and the process
    has exited. code is the exit status, or 128+signal when killed.
    stderr is collected into `log` for "Show details".
    """

    def __init__(
        self,
        argv: list[str],
        on_event: Callable[[protocol.Event], None],
        on_exit: Callable[[int], None],
        pass_fd: int | None = None,
    ) -> None:
        self.argv = argv
        self._on_event = on_event
        self._on_exit = on_exit
        self._pass_fd = pass_fd
        self._proc: Gio.Subprocess | None = None
        self._cancellable = Gio.Cancellable()
        self._pending = 0
        self.log: list[str] = []
        self.exit_code: int | None = None

    def start(self) -> None:
        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
        if self._pass_fd is not None:
            # Ownership moves to the launcher; the child sees it as DEVICE_FD.
            launcher.take_fd(self._pass_fd, DEVICE_FD)
            self._pass_fd = None
        self.log.append("$ " + shlex.join(self.argv))
        self._proc = launcher.spawnv(self.argv)
        self._pending = 3
        self._read_lines(self._proc.get_stdout_pipe(), self._stdout_line)
        self._read_lines(self._proc.get_stderr_pipe(), self._stderr_line)
        self._proc.wait_async(None, self._waited)

    def signal(self, signum: int = signal.SIGTERM) -> None:
        if self._proc is not None and self.exit_code is None:
            self._proc.send_signal(signum)

    @property
    def running(self) -> bool:
        return self._proc is not None and self.exit_code is None

    # -- internals ---------------------------------------------------
    def _read_lines(self, stream: Gio.InputStream, handle: Callable[[str], None]) -> None:
        # read_bytes_async rather than DataInputStream.read_line_async:
        # PyGObject cannot tell an empty line from end of stream there.
        pending = bytearray()

        def on_bytes(src, res):
            try:
                chunk = src.read_bytes_finish(res).get_data() or b""
            except GLib.Error as exc:
                self.log.append(f"[read error: {exc.message}]")
                chunk = b""
            if not chunk:
                if pending:
                    handle(pending.decode("utf-8", errors="replace"))
                self._settle()
                return
            pending.extend(chunk)
            *lines, rest = pending.split(b"\n")
            pending[:] = rest
            for line in lines:
                handle(line.decode("utf-8", errors="replace").rstrip("\r"))
            src.read_bytes_async(_READ_SIZE, GLib.PRIORITY_DEFAULT, self._cancellable, on_bytes)

        stream.read_bytes_async(_READ_SIZE, GLib.PRIORITY_DEFAULT, self._cancellable, on_bytes)

    def _stdout_line(self, line: str) -> None:
        try:
            event = protocol.parse_event(line)
        except protocol.ProtocolError as exc:
            self.log.append(f"[unexpected output: {exc}] {line}")
            return
        if isinstance(event, protocol.Log):
            self.log.append(f"{event.level}: {event.message}")
        elif isinstance(event, protocol.Error):
            self.log.append(f"error ({event.kind}): {event.message}")
        if event is not None:
            self._on_event(event)

    def _stderr_line(self, line: str) -> None:
        self.log.append(line)
        print(line, file=sys.stderr)

    def _waited(self, proc, res) -> None:
        try:
            proc.wait_finish(res)
        except GLib.Error:
            pass
        if proc.get_if_exited():
            self.exit_code = proc.get_exit_status()
        elif proc.get_if_signaled():
            self.exit_code = 128 + proc.get_term_sig()
        else:
            self.exit_code = protocol.EXIT_FAILURE
        self.log.append(f"[exit {self.exit_code}]")
        self._settle()

    def _settle(self) -> None:
        self._pending -= 1
        if self._pending == 0:
            self._on_exit(self.exit_code)
