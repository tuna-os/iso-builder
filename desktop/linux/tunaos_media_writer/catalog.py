"""The helper's `catalog` event as a model, plus the default-selection rules.

GUIs show standard/generic targets for the host architecture by default.
"""

from __future__ import annotations

import platform as _platform
from dataclasses import dataclass
from typing import Any

DEFAULT_EDITION = "standard"
DEFAULT_HARDWARE = "generic"

_MACHINE_PLATFORMS = {
    "x86_64": "linux/amd64",
    "amd64": "linux/amd64",
    "aarch64": "linux/arm64",
    "arm64": "linux/arm64",
}


def host_platform(machine: str | None = None) -> str:
    machine = (machine or _platform.machine()).lower()
    return _MACHINE_PLATFORMS.get(machine, f"linux/{machine}")


@dataclass(frozen=True)
class Desktop:
    id: str
    label: str
    description: str = ""


@dataclass(frozen=True)
class Base:
    id: str
    label: str


@dataclass(frozen=True)
class Target:
    id: str
    base: str
    desktop: str
    platform: str
    edition: str = DEFAULT_EDITION
    hardware: str = DEFAULT_HARDWARE
    image: str = ""
    compressed_size: int = 0


def _s(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key)
    return value if isinstance(value, str) else ""


class Catalog:
    def __init__(self, desktops, bases, targets, default_target: str = "", snapshot_digest: str = ""):
        self.desktops: tuple[Desktop, ...] = tuple(desktops)
        self.bases: tuple[Base, ...] = tuple(bases)
        self.targets: tuple[Target, ...] = tuple(targets)
        self.default_target = default_target
        self.snapshot_digest = snapshot_digest

    @classmethod
    def from_event(cls, data: dict[str, Any]) -> "Catalog":
        def items(key):
            raw = data.get(key)
            return [x for x in raw if isinstance(x, dict) and _s(x, "id")] if isinstance(raw, list) else []

        desktops = [Desktop(_s(d, "id"), _s(d, "label") or _s(d, "id"), _s(d, "description")) for d in items("desktops")]
        bases = [Base(_s(b, "id"), _s(b, "label") or _s(b, "id")) for b in items("bases")]
        targets = []
        for t in items("targets"):
            size = t.get("compressedSize")
            targets.append(
                Target(
                    id=_s(t, "id"),
                    base=_s(t, "base"),
                    desktop=_s(t, "desktop"),
                    platform=_s(t, "platform"),
                    edition=_s(t, "edition") or DEFAULT_EDITION,
                    hardware=_s(t, "hardware") or DEFAULT_HARDWARE,
                    image=_s(t, "image"),
                    compressed_size=size if isinstance(size, int) and not isinstance(size, bool) else 0,
                )
            )
        return cls(desktops, bases, targets, _s(data, "defaultTarget"), _s(data, "snapshotDigest"))

    def _default_targets(self, platform: str) -> list[Target]:
        return [
            t
            for t in self.targets
            if t.platform == platform and t.edition == DEFAULT_EDITION and t.hardware == DEFAULT_HARDWARE
        ]

    def desktops_for(self, platform: str) -> list[Desktop]:
        """Desktops with at least one default target, in catalog order."""
        offered = {t.desktop for t in self._default_targets(platform)}
        return [d for d in self.desktops if d.id in offered]

    def bases_for(self, desktop_id: str, platform: str) -> list[Base]:
        offered = {t.base for t in self._default_targets(platform) if t.desktop == desktop_id}
        return [b for b in self.bases if b.id in offered]

    def target_for(self, base_id: str, desktop_id: str, platform: str) -> Target | None:
        for t in self._default_targets(platform):
            if t.base == base_id and t.desktop == desktop_id:
                return t
        return None

    def _default(self) -> Target | None:
        return next((t for t in self.targets if t.id == self.default_target), None)

    def default_base_for(self, desktop_id: str, platform: str) -> str | None:
        """The catalog default's base when it offers this desktop, else the first base."""
        bases = self.bases_for(desktop_id, platform)
        if not bases:
            return None
        default = self._default()
        if default and any(b.id == default.base for b in bases):
            return default.base
        return bases[0].id

    def default_desktop(self, platform: str) -> str | None:
        desktops = self.desktops_for(platform)
        if not desktops:
            return None
        default = self._default()
        if default and any(d.id == default.desktop for d in desktops):
            return default.desktop
        return desktops[0].id

    def desktop(self, desktop_id: str) -> Desktop | None:
        return next((d for d in self.desktops if d.id == desktop_id), None)

    def base(self, base_id: str) -> Base | None:
        return next((b for b in self.bases if b.id == base_id), None)
