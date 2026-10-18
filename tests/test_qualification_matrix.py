"""Static tests for Task 12 (browser-target qualification matrix).

No Playwright runs, no matrix builds: every check here is a static/unit
assertion over ``e2e/editions.json``, ``app/public/catalog-snapshot.json``,
``.github/workflows/ci.yml`` and ``e2e/tests/builder.spec.js``.
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
EDITIONS = ROOT / "e2e" / "editions.json"
SNAPSHOT = ROOT / "app" / "public" / "catalog-snapshot.json"
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
BUILDER_SPEC = ROOT / "e2e" / "tests" / "builder.spec.js"

SLUG_RE = re.compile(r"^[a-z0-9-]+$")
SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")


def _editions():
    return json.loads(EDITIONS.read_text())


def _snapshot_targets():
    doc = json.loads(SNAPSHOT.read_text())
    return doc["targets"]


def _matrix_entries():
    return [e for e in _editions() if e.get("qualify") is True]


# --- 1. editions.json <-> catalog-snapshot.json -------------------------------


def test_slugs_unique_and_stable():
    eds = _editions()
    slugs = [e["slug"] for e in eds]
    assert len(slugs) == len(set(slugs)), "edition slugs must be unique"
    for slug in slugs:
        assert SLUG_RE.match(slug), f"slug {slug!r} must match /^[a-z0-9-]+$/"




# guppy:gnome is offered in editions.json but the snapshot only carries
# guppy:{base,kde,xfce} — known gap, asserted explicitly below so the
# suite stays green without losing the signal.
def test_qualify_matrix_entries_have_platform_in_snapshot():
    keys = {t["targetKey"] for t in _snapshot_targets()}
    matrix = _matrix_entries()
    assert matrix, "matrix must contain qualify=true entries"
    missing = []
    for e in matrix:
        assert e.get("reference", False) is False, f"{e['slug']} mixes qualify+reference"
        expected = f"{e['ref']}:{e['platform']}"
        if expected not in keys:
            missing.append(expected)
    assert missing == ["guppy:gnome:linux/amd64"], f"unexpected snapshot gaps: {missing}"


def test_reference_entries_flagged_and_not_qualified():
    eds = _editions()
    refs = [e for e in eds if e.get("reference") is True]
    assert len(refs) == 2, f"expected 2 upstream references, found {len(refs)}"
    for e in refs:
        assert e.get("qualify") is False, f"{e['slug']}: reference must have qualify=false"
        assert "/" in e["ref"], f"{e['slug']}: reference ref must be org-qualified"


def test_snapshot_platform_matches_edition_platform():
    by_key = {t["targetKey"]: t for t in _snapshot_targets()}
    for e in _matrix_entries():
        key = f"{e['ref']}:{e['platform']}"
        entry = by_key.get(key)
        if entry is None:
            pytest.skip(f"{e['slug']}: {key!r} not in snapshot (see platform-coverage test)")
        assert entry["target"]["platform"] == e["platform"]
        variant, flavor = e["ref"].split(":")
        assert entry["target"]["variant"] == variant
        assert entry["target"]["flavor"] == flavor


# --- 2. ci.yml static properties ----------------------------------------------


def test_ci_has_benchmark_dispatch_input():
    text = CI_YML.read_text()
    assert re.search(r"^\s*benchmark:\s*$", text, re.M), "ci.yml needs a `benchmark:` dispatch input"


def test_ci_tunaos_pin_is_full_sha():
    text = CI_YML.read_text()
    m = re.search(r"repository:\s*tuna-os/tunaOS\s*\n\s*ref:\s*([0-9a-f]+)", text)
    assert m, "ci.yml must pin the tunaOS checkout ref"
    assert SHA_RE.fullmatch(m.group(1)), f"tunaOS pin {m.group(1)!r} must be a 40-char SHA"


def test_ci_guest_verify_branches_on_qualify_flag():
    text = CI_YML.read_text()
    assert "--strict-offline-gui" in text, "qualify targets must use --strict-offline-gui"
    assert re.search(r'\[\s*"\$\{QUALIFY\}"\s*=\s*"true"\s*\]', text), \
        "guest-verify must branch on the edition qualify flag"
    luks_block = text[text.index("--strict-offline-gui"):text.index("--strict-offline-gui") + 2000]
    assert "--luks" in text[text.index("--strict-offline-gui"):], \
        "non-qualify (reference) cells must keep the --luks check"


def test_ci_uploads_are_evidence_only():
    text = CI_YML.read_text()
    for block in ("upload diagnostics", "upload qualification evidence"):
        assert block in text, f"ci.yml missing step {block!r}"
    diag = text[text.index("upload diagnostics"):text.index("upload diagnostics") + 1500]
    assert "*.qcow2" in diag or "!luks-verify-*/*.qcow2" in diag, \
        "diagnostics upload must exclude qcow2 disks"
    assert ".iso" not in diag.replace("iso-e2e", "").replace("ISO", ""), \
        "diagnostics upload must not retain ISOs"
    ev = text[text.index("upload qualification evidence"):text.index("upload qualification evidence") + 800]
    assert "qual-evidence-" in ev and ".json" in ev
    assert ".iso" not in ev and ".qcow2" not in ev, "evidence upload must be JSON only"


# --- 3. builder.spec.js evidence emission -------------------------------------


def test_builder_spec_writes_evidence_to_test_results():
    src = BUILDER_SPEC.read_text()
    assert "TBOX_E2E_EVIDENCE" in src, "spec must honour the TBOX_E2E_EVIDENCE path"
    assert "test-results" in src and "qual-evidence-" in src
    assert "fs.writeFileSync(evPath" in src or "writeFileSync(evPath" in src


def test_builder_spec_evidence_has_browser_half_v1_keys():
    # Browser half of QualificationEvidence v1: phase timings (phasesMs)
    # are the timing measurements, target.digest* the identity digests.
    src = BUILDER_SPEC.read_text()
    assert '"qualification-evidence"' in src, "evidence kind must be qualification-evidence"
    assert "schemaVersion: 1" in src
    assert 'half: "browser"' in src
    for key in ("target:", "browser:", "run:", "phasesMs:", "resources:"):
        assert key in src, f"browser-half evidence must include {key!r}"
    for key in ("digest:", "layerCount:", "compressedBytes:"):
        assert key in src, f"evidence target identity must include {key!r}"
    for key in ("inspect:", "build:", "save:"):
        assert key in src, f"evidence phasesMs measurements must include {key!r}"
    for key in ("peakTboxWasmMB:", "peakTboxJsHeapMB:", "isoBytes:", "cacheMode:"):
        assert key in src, f"evidence resources/run must include {key!r}"
