"""The four-step flow (choose → destination → progress → done/error) as a
pure state machine. The window renders whatever state this holds; the
controller feeds it helper events. No GTK here, so it is unit-testable.
"""

from __future__ import annotations

import enum
import os
from dataclasses import dataclass
from typing import Callable

from . import protocol, strings
from .catalog import Catalog, Target
from .protocol import Drive


class Step(enum.Enum):
    LOADING = "loading"
    CHOOSE = "choose"
    DESTINATION = "destination"
    PROGRESS = "progress"
    DONE = "done"
    ERROR = "error"


class Stage(enum.Enum):
    PREPARING = "preparing"
    DOWNLOADING = "downloading"
    BUILDING = "building"
    WAITING_PERMISSION = "waiting-permission"
    WRITING = "writing"
    VERIFYING = "verifying"
    CANCELLING = "cancelling"


class Notice(enum.Enum):
    CANCELLED = "cancelled"


class InvalidTransition(RuntimeError):
    pass


@dataclass(frozen=True)
class Source:
    """What to build: a catalog target or a build-request.json file."""

    label: str
    save_name: str
    target_id: str = ""
    request_path: str = ""

    @property
    def key(self) -> str:
        return self.target_id or f"request:{self.request_path}"

    def build_args(self) -> list[str]:
        if self.target_id:
            return ["--target", self.target_id]
        return ["--request", self.request_path]

    @classmethod
    def from_target(cls, catalog: Catalog, target: Target) -> "Source":
        desktop = catalog.desktop(target.desktop)
        base = catalog.base(target.base)
        label = strings.SOURCE_LABEL.format(
            desktop=desktop.label if desktop else target.desktop,
            base=base.label if base else target.base,
        )
        return cls(label=label, save_name=f"tunaos-{target.base}-{target.desktop}.iso", target_id=target.id)

    @classmethod
    def from_request(cls, path: str, data: object) -> "Source":
        """A build-request.json exported from iso.tunaos.org (BuildRequest v1).
        Raises ValueError when data does not look like one."""
        if not isinstance(data, dict) or not isinstance(data.get("image"), str) or not data["image"]:
            raise ValueError("not a build request")
        if data.get("schemaVersion") != 1:
            raise ValueError("unsupported build request version")
        options = data.get("options") if isinstance(data.get("options"), dict) else {}
        label = options.get("label") if isinstance(options.get("label"), str) else ""
        name = options.get("outputFilename") if isinstance(options.get("outputFilename"), str) else ""
        name = os.path.basename(name)
        if not name:
            name = os.path.splitext(os.path.basename(path))[0] + ".iso"
        return cls(label=label or os.path.basename(path), save_name=name, request_path=path)


@dataclass(frozen=True)
class DriveDestination:
    drive: Drive
    label: str


@dataclass(frozen=True)
class FileDestination:
    path: str


Destination = DriveDestination | FileDestination


def stage_for_phase(phase: str) -> Stage:
    if phase in protocol.DOWNLOAD_PHASES:
        return Stage.DOWNLOADING
    if phase in protocol.WRITE_PHASES:
        return Stage.WRITING
    if phase in protocol.VERIFY_PHASES:
        return Stage.VERIFYING
    return Stage.BUILDING


class Flow:
    def __init__(self) -> None:
        self.step = Step.LOADING
        self.catalog: Catalog | None = None
        self.source: Source | None = None
        self.destination: Destination | None = None
        self.stage = Stage.PREPARING
        self.progress: protocol.Progress | None = None
        self.error: protocol.Error | None = None
        self.result: protocol.Done | None = None
        self._notice: Notice | None = None
        self._listeners: list[Callable[["Flow"], None]] = []

    # -- observation -------------------------------------------------
    def connect(self, listener: Callable[["Flow"], None]) -> None:
        self._listeners.append(listener)

    def _changed(self) -> None:
        for listener in list(self._listeners):
            listener(self)

    def take_notice(self) -> Notice | None:
        notice, self._notice = self._notice, None
        return notice

    @property
    def fraction(self) -> float | None:
        """Progress of the current stage, None = unknown (pulse)."""
        if self.progress is None or stage_for_phase(self.progress.phase) != self.stage:
            return None
        return self.progress.fraction

    @property
    def writes_drive(self) -> bool:
        return isinstance(self.destination, DriveDestination)

    def _require(self, *steps: Step) -> None:
        if self.step not in steps:
            raise InvalidTransition(f"{self.step.value} does not accept this")

    # -- transitions -------------------------------------------------
    def catalog_loaded(self, catalog: Catalog) -> None:
        self._require(Step.LOADING)
        self.catalog = catalog
        self.step = Step.CHOOSE
        self._changed()

    def choose(self, source: Source) -> None:
        self._require(Step.CHOOSE)
        self.source = source
        self.step = Step.DESTINATION
        self._changed()

    def back(self) -> None:
        self._require(Step.DESTINATION)
        self.step = Step.CHOOSE
        self._changed()

    def start(self, destination: Destination) -> None:
        self._require(Step.DESTINATION)
        self.destination = destination
        self.step = Step.PROGRESS
        self.stage = Stage.PREPARING
        self.progress = None
        self.error = None
        self.result = None
        self._changed()

    def on_progress(self, event: protocol.Progress) -> None:
        self._require(Step.PROGRESS)
        if self.stage is Stage.CANCELLING:
            return
        self.progress = event
        self.stage = stage_for_phase(event.phase)
        self._changed()

    def build_done(self, done: protocol.Done) -> None:
        """The ISO exists. File destination: finished. Drive: ask to write."""
        self._require(Step.PROGRESS)
        if self.stage is Stage.CANCELLING:
            return
        self.progress = None
        if isinstance(self.destination, FileDestination):
            self.result = done
            self.step = Step.DONE
        else:
            self.stage = Stage.WAITING_PERMISSION
        self._changed()

    def write_started(self) -> None:
        self._require(Step.PROGRESS)
        if self.stage is Stage.CANCELLING:
            return
        self.stage = Stage.WRITING
        self.progress = None
        self._changed()

    def write_done(self, done: protocol.Done) -> None:
        self._require(Step.PROGRESS)
        self.result = done
        self.step = Step.DONE
        self._changed()

    def cancel(self) -> None:
        self._require(Step.PROGRESS)
        self.stage = Stage.CANCELLING
        self._changed()

    def cancelled(self) -> None:
        """The running job stopped after a cancel request (or was refused)."""
        self._require(Step.PROGRESS)
        self.step = Step.DESTINATION
        self.destination = None
        self.progress = None
        self._notice = Notice.CANCELLED
        self._changed()

    def fail(self, kind: str, message: str) -> None:
        if kind == "cancelled" and self.step is Step.PROGRESS:
            self.cancelled()
            return
        self.error = protocol.Error(kind=kind, message=message)
        self.step = Step.ERROR
        self._changed()

    def retry(self) -> None:
        self._require(Step.ERROR)
        self.error = None
        if self.catalog is None:
            self.step = Step.LOADING
        elif self.source is None:
            self.step = Step.CHOOSE
        else:
            self.step = Step.DESTINATION
        self.destination = None
        self._changed()

    def start_over(self) -> None:
        self._require(Step.DONE)
        self.source = None
        self.destination = None
        self.result = None
        self.step = Step.CHOOSE
        self._changed()
