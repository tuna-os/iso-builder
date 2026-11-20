"""Links from iso.tunaos.org that open the app on a catalog target.

Two equivalent forms (see ../../PROTOCOL.md, "Opening the app on a target"):

    tunaos-media-writer --target yellowfin:gnome:linux/amd64
    tunaos-media-writer 'tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64'

This module only checks the form. Whether the catalog offers the target is
the flow's decision (Flow.open_target).
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

SCHEME = "tunaos-media-writer"
ACTION = "build"

# base:desktop:os/arch[/variant], as the catalog's target ids are spelled.
_TARGET_ID = re.compile(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*:[a-z0-9]+(?:/[a-z0-9._-]+)+")


class LinkError(ValueError):
    """The argument is not a link or target id this app understands."""


def target_id(value: str) -> str:
    """The `--target` value, checked for the shape of a catalog target id."""
    if not _TARGET_ID.fullmatch(value):
        raise LinkError(f"{value!r} is not a catalog target id (base:desktop:os/arch)")
    return value


def target_from_uri(uri: str) -> str:
    """The target id of a `tunaos-media-writer://build?target=ID` link."""
    parts = urlsplit(uri)
    if parts.scheme.lower() != SCHEME:
        raise LinkError(f"{uri!r} is not a {SCHEME}:// link")
    if parts.netloc.lower() != ACTION or parts.path not in ("", "/"):
        raise LinkError(f"{uri!r}: unknown action (expected {SCHEME}://{ACTION}?target=ID)")
    values = parse_qs(parts.query).get("target", [])
    if len(values) != 1:
        raise LinkError(f"{uri!r}: needs exactly one target=ID")
    return target_id(values[0])
