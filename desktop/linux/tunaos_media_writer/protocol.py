"""tunaos-media-helper JSON Lines events (desktop/PROTOCOL.md, version 1).

Pure Python: no GTK, so it is unit-testable anywhere. Unknown fields and
unknown event names are ignored, as the protocol requires.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Union

PROTOCOL_VERSION = 1

# Exit codes of the helper.
EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_CANCELLED = 130

# Progress phases grouped into the four stages the GUI names.
DOWNLOAD_PHASES = frozenset({"download"})
BUILD_PHASES = frozenset({"unpack", "overlay", "erofs", "esp", "iso"})
WRITE_PHASES = frozenset({"write"})
VERIFY_PHASES = frozenset({"verify"})


class ProtocolError(ValueError):
    """A stdout line that is not a protocol event."""


@dataclass(frozen=True)
class Progress:
    phase: str
    current: int
    total: int
    unit: str = ""
    message: str = ""

    @property
    def fraction(self) -> float | None:
        """0..1, or None when the total is unknown (pulse the bar)."""
        if self.total <= 0:
            return None
        return max(0.0, min(1.0, self.current / self.total))


@dataclass(frozen=True)
class Log:
    level: str
    message: str


@dataclass(frozen=True)
class Error:
    kind: str
    message: str


@dataclass(frozen=True)
class Version:
    helper: str
    engine: str
    protocol: int


@dataclass(frozen=True)
class Drive:
    id: str
    path: str
    name: str
    size_bytes: int
    bus: str = "other"
    removable: bool = False
    mounted: tuple[str, ...] = ()
    system_disk: bool = False


@dataclass(frozen=True)
class Drives:
    drives: tuple[Drive, ...]


@dataclass(frozen=True)
class CatalogEvent:
    data: dict[str, Any] = field(compare=False)


@dataclass(frozen=True)
class Done:
    """`build` sets path/sha256; `write` sets device/verified."""

    bytes: int = 0
    path: str = ""
    sha256: str = ""
    device: str = ""
    verified: bool = False


Event = Union[Progress, Log, Error, Version, Drives, CatalogEvent, Done]


def _int(obj: dict[str, Any], key: str) -> int:
    value = obj.get(key, 0)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _str(obj: dict[str, Any], key: str, default: str = "") -> str:
    value = obj.get(key, default)
    return value if isinstance(value, str) else default


def _drive(obj: Any) -> Drive | None:
    if not isinstance(obj, dict):
        return None
    drive_id, path = _str(obj, "id"), _str(obj, "path")
    if not drive_id or not path:
        return None
    mounted = obj.get("mounted") or []
    return Drive(
        id=drive_id,
        path=path,
        name=_str(obj, "name"),
        size_bytes=_int(obj, "sizeBytes"),
        bus=_str(obj, "bus", "other") or "other",
        removable=obj.get("removable") is True,
        mounted=tuple(m for m in mounted if isinstance(m, str)) if isinstance(mounted, list) else (),
        # Anything but an explicit false (including a missing field) is a system disk.
        system_disk=obj.get("systemDisk") is not False,
    )


def parse_event(line: str | bytes) -> Event | None:
    """Parse one JSONL line. None for blank lines and unknown events.

    Raises ProtocolError for lines that are not a JSON object with an
    "event" string (callers log those to the details view and go on).
    """
    if isinstance(line, bytes):
        line = line.decode("utf-8", errors="replace")
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"not JSON: {exc}") from exc
    if not isinstance(obj, dict) or not isinstance(obj.get("event"), str):
        raise ProtocolError("not an event object")

    name = obj["event"]
    if name == "progress":
        return Progress(
            phase=_str(obj, "phase"),
            current=_int(obj, "current"),
            total=_int(obj, "total"),
            unit=_str(obj, "unit"),
            message=_str(obj, "message"),
        )
    if name == "log":
        return Log(level=_str(obj, "level", "info"), message=_str(obj, "message"))
    if name == "error":
        return Error(kind=_str(obj, "kind", "engine"), message=_str(obj, "message"))
    if name == "version":
        return Version(helper=_str(obj, "helper"), engine=_str(obj, "engine"), protocol=_int(obj, "protocol"))
    if name == "drives":
        raw = obj.get("drives")
        drives = [_drive(d) for d in raw] if isinstance(raw, list) else []
        return Drives(drives=tuple(d for d in drives if d is not None))
    if name == "catalog":
        return CatalogEvent(data=obj)
    if name == "done":
        return Done(
            bytes=_int(obj, "bytes"),
            path=_str(obj, "path"),
            sha256=_str(obj, "sha256"),
            device=_str(obj, "device"),
            verified=obj.get("verified") is True,
        )
    return None
