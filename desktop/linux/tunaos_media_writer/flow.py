"""The four-step flow (choose → destination → progress → done/error) as a
pure state machine. The window renders whatever state this holds; the
controller feeds it helper events. No GTK here, so it is unit-testable.
"""

from __future__ import annotations

import enum
import os
import re
from dataclasses import dataclass
from typing import Callable

from . import protocol, strings
from .catalog import Catalog, Target
from .protocol import Drive

# A manifest digest pins the exact image bytes a cell link means.
_DIGEST = re.compile(r"sha256:[0-9a-fA-F]{64}")


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
    LINK_INVALID = "link-invalid"
    LINK_UNKNOWN_TARGET = "link-unknown-target"
    LINK_BUSY = "link-busy"


class InvalidTransition(RuntimeError):
    pass


@dataclass(frozen=True)
class Source:
    """What to fetch or build: a catalog target, a build-request.json file,
    or (with cell set) a prepared installer image."""

    label: str
    save_name: str
    target_id: str = ""
    request_path: str = ""
    cell: str = ""
    digest: str = ""

    @property
    def key(self) -> str:
        base = self.target_id or f"request:{self.request_path}"
        if self.cell:
            base += f"|cell:{self.cell}"
        return base

    def build_args(self) -> list[str]:
        if self.cell:
            return ["--cell", self.cell]
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
        cell = data.get("cell") if isinstance(data.get("cell"), str) else ""
        digest = data.get("digest") if isinstance(data.get("digest"), str) else ""
        if digest and not _DIGEST.fullmatch(digest):
            raise ValueError("bad cell digest")
        return cls(label=label or os.path.basename(path), save_name=name, request_path=path,
                   cell=cell, digest=digest)


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
        self.pending_target: tuple[str, str, str] | None = None  # a link that arrived before the catalog
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
        if self.pending_target is not None:
            pending, self.pending_target = self.pending_target, None
            self.open_target(*pending)

    def open_target(self, target_id: str, cell: str = "", digest: str = "") -> None:
        """A link (`--target ID` or tunaos-media-writer://build?target=ID):
        select that catalog target exactly like picking it on step 1 and
        pressing Continue, then wait on step 2 for the user to choose where
        it goes. Never starts a job. Unknown target: notice, nothing selected.
        A cell names the prepared image to fetch instead of building; a
        digest pins its manifest."""
        if self.step is Step.PROGRESS:
            self._notify(Notice.LINK_BUSY)
            return
        if self.catalog is None:
            self.pending_target = (target_id, cell, digest)  # applied by catalog_loaded
            return
        target = self.catalog.target(target_id)
        if target is None:
            self._notify(Notice.LINK_UNKNOWN_TARGET)
            return
        self.source = Source.from_target(self.catalog, target)
        if cell:
            self.source = Source(label=self.source.label, save_name=self.source.save_name,
                                 target_id=self.source.target_id, cell=cell, digest=digest)
        self.destination = None
        self.error = None
        self.result = None
        self.step = Step.DESTINATION
        self._changed()

    def link_rejected(self) -> None:
        """A link or --target value that is not one (see launch.py)."""
        self._notify(Notice.LINK_INVALID)

    def _notify(self, notice: Notice) -> None:
        self._notice = notice
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
