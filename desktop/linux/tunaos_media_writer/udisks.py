"""udisks2 over GDBus: hotplug notifications, unmounting, and opening the
target disk for writing behind a polkit prompt.

Inside the Flatpak the app has no /dev access; udisks2 opens the device
(Block.OpenDevice, polkit `org.freedesktop.udisks2.open-device`) and hands
back a file descriptor that is passed on to `tunaos-media-helper write --fd`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable

from gi.repository import Gio, GLib

from . import strings

BUS_NAME = "org.freedesktop.UDisks2"
MANAGER_PATH = "/org/freedesktop/UDisks2"
BLOCK = "org.freedesktop.UDisks2.Block"
DRIVE = "org.freedesktop.UDisks2.Drive"
PARTITION = "org.freedesktop.UDisks2.Partition"
FILESYSTEM = "org.freedesktop.UDisks2.Filesystem"
ENCRYPTED = "org.freedesktop.UDisks2.Encrypted"

_NO_OBJECT = "/"
_CALL_FLAGS = Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION
# A polkit prompt waits for the user; never time the call out under them.
_CALL_TIMEOUT_MS = GLib.MAXINT


@dataclass(frozen=True)
class BlockInfo:
    object_path: str
    hint_system: bool
    vendor: str
    model: str

    @property
    def display_name(self) -> str:
        return " ".join(p for p in (self.vendor, self.model) if p)


@dataclass(frozen=True)
class OpenFailure:
    """Why the device could not be opened. kind is a protocol error kind."""

    kind: str
    message: str
    detail: str


def _prop(obj: Gio.DBusObject, iface: str, name: str) -> GLib.Variant | None:
    proxy = obj.get_interface(iface)
    if proxy is None:
        return None
    return proxy.get_cached_property(name)


def _path_prop(obj: Gio.DBusObject, iface: str, name: str) -> str:
    value = _prop(obj, iface, name)
    return value.get_string() if value is not None else _NO_OBJECT


def _str_prop(obj: Gio.DBusObject, iface: str, name: str) -> str:
    value = _prop(obj, iface, name)
    return value.get_string().strip() if value is not None else ""


def _failure_for(error: GLib.Error, message: str) -> OpenFailure:
    if error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
        return OpenFailure("cancelled", "", error.message)
    remote = Gio.DBusError.get_remote_error(error) or ""
    if "NotAuthorized" in remote:
        return OpenFailure("permission", strings.ERROR_PERMISSION, error.message)
    return OpenFailure("storage", message, error.message)


class UDisks:
    """Thin client over the udisks2 object manager. Construct with connect()."""

    def __init__(self, manager: Gio.DBusObjectManagerClient) -> None:
        self._manager = manager
        self._conn: Gio.DBusConnection = manager.get_connection()

    @classmethod
    def connect(cls) -> "UDisks | None":
        try:
            manager = Gio.DBusObjectManagerClient.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusObjectManagerClientFlags.NONE,
                BUS_NAME,
                MANAGER_PATH,
                None,
                None,
                None,
            )
        except GLib.Error as exc:
            print(f"udisks2 unavailable: {exc.message}")
            return None
        if manager.get_name_owner() is None:
            print("udisks2 is not running")
            return None
        return cls(manager)

    def watch(self, on_changed: Callable[[], None]) -> None:
        """Call on_changed after any hotplug or mount change."""
        for signal in (
            "object-added",
            "object-removed",
            "interface-added",
            "interface-removed",
            "interface-proxy-properties-changed",
        ):
            self._manager.connect(signal, lambda *_a: on_changed())

    # -- lookup ------------------------------------------------------
    def block_for_device(self, device_path: str) -> BlockInfo | None:
        """The udisks2 block object for a /dev path the helper listed."""
        wanted = {device_path, os.path.realpath(device_path)}
        for obj in self._manager.get_objects():
            block = obj.get_interface(BLOCK)
            if block is None:
                continue
            names = set()
            for key in ("Device", "PreferredDevice"):
                value = block.get_cached_property(key)
                if value is not None:
                    names.add(value.get_bytestring().decode(errors="replace"))
            links = block.get_cached_property("Symlinks")
            if links is not None:
                names.update(links.get_bytestring_array())
            if not names & wanted:
                continue
            hint = block.get_cached_property("HintSystem")
            vendor = model = ""
            drive_path = _path_prop(obj, BLOCK, "Drive")
            drive = self._manager.get_object(drive_path) if drive_path != _NO_OBJECT else None
            if drive is not None:
                vendor, model = _str_prop(drive, DRIVE, "Vendor"), _str_prop(drive, DRIVE, "Model")
            return BlockInfo(obj.get_object_path(), hint is None or hint.get_boolean(), vendor, model)
        return None

    def _plan_release(self, whole_disk: str) -> list[tuple[str, str]]:
        """(object path, interface) calls that free every volume on the disk:
        unmount mounted filesystems (including unlocked LUKS cleartext
        devices), then lock unlocked LUKS containers."""
        objects = self._manager.get_objects()
        members = {
            o.get_object_path()
            for o in objects
            if o.get_object_path() == whole_disk or _path_prop(o, PARTITION, "Table") == whole_disk
        }
        unmounts: list[tuple[str, str]] = []
        locks: list[tuple[str, str]] = []
        for obj in objects:
            path = obj.get_object_path()
            if path in members or _path_prop(obj, BLOCK, "CryptoBackingDevice") in members:
                mounts = _prop(obj, FILESYSTEM, "MountPoints")
                if mounts is not None and mounts.get_bytestring_array():
                    unmounts.append((path, FILESYSTEM))
            if path in members and _path_prop(obj, ENCRYPTED, "CleartextDevice") != _NO_OBJECT:
                locks.append((path, ENCRYPTED))
        return unmounts + locks

    # -- writing -----------------------------------------------------
    def open_for_writing(
        self,
        block: BlockInfo,
        cancellable: Gio.Cancellable,
        on_done: Callable[[int | None, OpenFailure | None], None],
    ) -> None:
        """Unmount/lock every volume, then Block.OpenDevice("rw", O_EXCL).

        "rw" rather than "w" so the helper can read back through the same fd
        for its verify phase; O_EXCL fails if anything still holds the disk.
        on_done(fd, None) hands over ownership of fd.
        """
        steps = self._plan_release(block.object_path)

        def next_step():
            if not steps:
                self._open(block, cancellable, on_done)
                return
            path, iface = steps.pop(0)
            method = "Unmount" if iface == FILESYSTEM else "Lock"
            self._conn.call(
                BUS_NAME, path, iface, method, GLib.Variant("(a{sv})", ({},)), None,
                _CALL_FLAGS, _CALL_TIMEOUT_MS, cancellable, released, None,
            )

        def released(conn, res, _data):
            try:
                conn.call_finish(res)
            except GLib.Error as exc:
                on_done(None, _failure_for(exc, strings.ERROR_UNMOUNT))
                return
            next_step()

        next_step()

    def _open(self, block, cancellable, on_done) -> None:
        params = GLib.Variant("(sa{sv})", ("rw", {"flags": GLib.Variant("i", os.O_EXCL)}))

        def opened(conn, res, _data):
            try:
                result, fd_list = conn.call_with_unix_fd_list_finish(res)
            except GLib.Error as exc:
                on_done(None, _failure_for(exc, strings.ERROR_OPEN_DEVICE))
                return
            # get() dups the descriptor; the list closes its own copy.
            on_done(fd_list.get(result.unpack()[0]), None)

        self._conn.call_with_unix_fd_list(
            BUS_NAME, block.object_path, BLOCK, "OpenDevice", params, GLib.VariantType("(h)"),
            _CALL_FLAGS, _CALL_TIMEOUT_MS, None, cancellable, opened, None,
        )
