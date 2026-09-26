#!/usr/bin/env python3
"""Cross-check the picker's variant/desktop matrix against tunaOS's own
build-config.yml — the actual source of truth for what tunaOS builds.

scripts/verify-catalog.py answers "does this ref exist on GHCR" — useful,
but it cannot tell a *correct* entry from a *stale* one: an orphaned tag
that upstream stopped building still resolves with 200 until the registry
eventually garbage-collects it. native/catalog_variants_test.go answers
"do app.js and catalog.go agree with each other" — useful, but as its own
doc comment says, it "cannot tell you the list is RIGHT — for that it
would have to read tunaOS's build-config.yml, which lives in another
repository." This script is that missing leg: it reads build-config.yml
from tuna-os/tunaos directly and diffs it against native/catalog.go's
`variants` table (which native/catalog_variants_test.go already pins
app.js to), the same way the two local copies are pinned to each other.

Two kinds of drift, reported differently:

  EXTRA   — this repo offers a <variant>:<desktop> cell that
            build-config.yml does NOT mark `build_image: true` (or whose
            variant is `experimental: true`, i.e. explicitly gated off).
            This is the picker asserting a fact that is not true upstream
            — the same failure mode as the flounder:niri dead entry
            (iso-builder#142), just caught one hop earlier, before GHCR
            ever needs to 404. FAILS the run.

  MISSING — build-config.yml marks a <variant>:<desktop> cell
            `build_image: true` and it is not offered here. iso-builder#142
            catalogued 16 of these and explicitly left the call to a human
            ("Decide the coverage contract for the 16 unreachable cells");
            this script's job is to make that gap loud instead of silent,
            not to adjudicate it. Printed, does NOT fail the run.

Only the top-level `variants:` list is in scope — `sibling_images:` are
separate repos (tromso, xfce-linux) with their own build/test pipelines,
not part of this catalog at all.

This job is deliberately wired to the weekly `schedule` trigger only (see
.github/workflows/ci.yml), not to every push/PR: build-config.yml is a
file this repo does not own, and gating merges on another team's edit
cadence is exactly the coupling iso-builder#142 warned against. It fails
loud once a week instead of never, which is what the existing "Weekly:
the app talks to live infra that can drift" cron comment already promised
and, per iso-builder#142, never actually did.

Exit status:
  0  no EXTRA drift (MISSING drift, if any, is printed but not fatal),
     or the fetch/parse was inconclusive (see below)
  1  at least one EXTRA cell: this repo offers something upstream does
     not build
  2  build-config.yml fetched but zero variants parsed, or catalog.go
     fetched but zero variants parsed — a pass would have meant nothing

A fetch that fails for any reason (network, rate limit, tunaOS renaming
the file) is reported as INCONCLUSIVE and exits 0, same rationale as
verify-catalog.py: this check guards against catalog drift, not against
GitHub being unreachable.
"""

from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG_GO = REPO_ROOT / "native" / "catalog.go"

BUILD_CONFIG_URL = (
    "https://raw.githubusercontent.com/tuna-os/tunaos/main/.github/build-config.yml"
)
TIMEOUT = 20

# The only desktop IDs this picker's matrix has any concept of (catalog.go's
# desktopName map / app.js's DESKTOPS). build-config.yml's flavors also
# include base/hwe/nvidia/asahi variants this picker never claims to offer,
# so those are deliberately not compared.
DESKTOP_IDS = {"gnome", "kde", "cosmic", "niri", "xfce"}

VARIANT_RE = re.compile(r'\{"([^"]+)",\s*"[^"]*",\s*\[\]string\{([^}]*)\}\}')
QUOTED = re.compile(r'"([^"]+)"')


def fetch(url: str) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            return resp.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError) as err:
        print(f"INCONCLUSIVE: could not fetch {url}: {err}", file=sys.stderr)
        return None


def parse_catalog_go() -> dict[str, set[str]]:
    """variant id -> desktop ids, from native/catalog.go's `variants` table."""
    src = CATALOG_GO.read_text()
    out: dict[str, set[str]] = {}
    for variant_id, desktops in VARIANT_RE.findall(src):
        out[variant_id] = set(QUOTED.findall(desktops))
    return out


def parse_build_config(text: str) -> dict[str, set[str]]:
    """variant id -> build_image:true desktop ids, from the top-level
    `variants:` list only (sibling_images: is a different set of repos
    entirely). A variant marked `experimental: true` is dropped — it is
    explicitly gated off from the normal release lanes (see wahoo in
    build-config.yml), so this picker offering it would not be "catching
    up", it would be jumping the gate.
    """
    variants: dict[str, set[str]] = {}
    experimental: set[str] = set()
    section: str | None = None
    cur_variant: str | None = None
    cur_flavor: str | None = None
    in_flavors = False

    for raw_line in text.splitlines():
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))

        if indent == 0 and stripped.endswith(":"):
            section = stripped[:-1]
            cur_variant = None
            cur_flavor = None
            in_flavors = False
            continue
        if section != "variants":
            continue

        m = re.match(r"- id:\s*(\S+)", stripped)
        if indent == 2 and m:
            cur_variant = m.group(1)
            variants[cur_variant] = set()
            cur_flavor = None
            in_flavors = False
            continue
        if cur_variant is None:
            continue

        if indent == 4:
            in_flavors = stripped == "flavors:"
            if stripped.startswith("experimental:"):
                if stripped.split(":", 1)[1].strip() == "true":
                    experimental.add(cur_variant)
            continue

        if in_flavors and indent == 6:
            fm = re.match(r"- id:\s*(\S+)", stripped)
            if fm:
                cur_flavor = fm.group(1)
            continue

        if in_flavors and indent == 8 and cur_flavor and stripped.startswith("build_image:"):
            if stripped.split(":", 1)[1].strip() == "true" and cur_flavor in DESKTOP_IDS:
                variants[cur_variant].add(cur_flavor)
            continue

    for vid in experimental:
        variants.pop(vid, None)
    return variants


def main() -> int:
    catalog = parse_catalog_go()
    if not catalog:
        print("FAIL: parsed zero variants from native/catalog.go — the parser "
              "is broken, not the data", file=sys.stderr)
        return 2

    raw = fetch(BUILD_CONFIG_URL)
    if raw is None:
        print("Not treated as a failure; tunaOS's build-config.yml, not this "
              "repo's catalog, was unreachable.")
        return 0

    upstream = parse_build_config(raw)
    if not upstream:
        print("FAIL: parsed zero variants from tunaOS's build-config.yml — "
              "the parser is broken, not the data (did the file's shape "
              "change?)", file=sys.stderr)
        return 2

    extra: list[tuple[str, str]] = []
    missing: list[tuple[str, str]] = []

    for vid, desktops in sorted(catalog.items()):
        upstream_desktops = upstream.get(vid, set())
        for de in sorted(desktops):
            if de not in upstream_desktops:
                extra.append((vid, de))

    for vid, desktops in sorted(upstream.items()):
        offered = catalog.get(vid, set())
        for de in sorted(desktops):
            if de not in offered:
                missing.append((vid, de))

    print(f"native/catalog.go: {sum(len(d) for d in catalog.values())} cells "
          f"across {len(catalog)} variants")
    print(f"tunaOS build-config.yml: {sum(len(d) for d in upstream.values())} "
          f"build_image:true desktop cells across {len(upstream)} variants "
          f"(experimental variants excluded)\n")

    if extra:
        print(f"EXTRA — offered here, not build_image:true upstream ({len(extra)}):")
        for vid, de in extra:
            reason = "variant not in build-config.yml at all" if vid not in upstream \
                else "not build_image:true for this desktop"
            print(f"  {vid}:{de}  ({reason})")
        print()

    if missing:
        print(f"MISSING — build_image:true upstream, not offered here ({len(missing)}):")
        for vid, de in missing:
            print(f"  {vid}:{de}")
        print(
            "\nNot a failure: iso-builder#142 left the coverage contract for "
            "these as an open product decision (mirror build-config.yml "
            "exactly, or document the picker as a curated subset). This is "
            "here so the gap is visible, not silent.\n"
        )

    if extra:
        print(
            f"FAIL: {len(extra)} cell(s) this repo offers are not "
            "build_image:true in tunaOS's build-config.yml. Either upstream "
            "stopped building them (stale/orphaned entry — see the "
            "'Orphaned tags' evidence in iso-builder#142) or the picker was "
            "never correct. Remove the entry from app/public/app.js and "
            "native/catalog.go, or confirm upstream and file a fix there."
        )
        return 1

    print("OK: every cell this repo offers is build_image:true upstream.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
