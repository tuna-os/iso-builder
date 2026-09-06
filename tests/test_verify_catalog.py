"""Unit tests for scripts/verify-catalog.py.

The script has run for real in CI since #146 (job `catalog-check`), which
exercises it end-to-end against the live registry — but nothing has ever
asserted its own parsing or retry logic in isolation. These tests cover the
two regex extractors and the network/retry paths without touching a real
network or the repo's actual app.js/catalog.go.
"""

import importlib.util
import sys
import urllib.error
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "verify-catalog.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("verify_catalog", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def vc():
    return _load_module()


# --- picker_refs -----------------------------------------------------------


def test_picker_refs_extracts_variant_desktop_pairs(vc, tmp_path):
    app_js = tmp_path / "app.js"
    app_js.write_text(
        'const VARIANTS = [\n'
        '  { id: "yellowfin", name: "AlmaLinux Kitten 10", des: ["gnome", "kde"] },\n'
        '  { id: "bonito",    name: "Fedora 44",            des: ["niri"] },\n'
        '];\n'
        'function currentVariant() {}\n'
    )
    vc.APP_JS = app_js

    refs = vc.picker_refs()

    assert refs == [
        ("tuna-os/yellowfin:gnome", "app.js VARIANTS"),
        ("tuna-os/yellowfin:kde", "app.js VARIANTS"),
        ("tuna-os/bonito:niri", "app.js VARIANTS"),
    ]


def test_picker_refs_does_not_strip_js_comments(vc, tmp_path):
    """VARIANT_ENTRY has no comment-awareness: a `//`-commented-out entry is
    parsed the same as a live one. app.js's own comment about the flounder/niri
    404 (removing the entry, not commenting it) exists because of exactly this
    — pin the behavior so a future "helpful" regex tweak doesn't get missed."""
    app_js = tmp_path / "app.js"
    app_js.write_text(
        'const VARIANTS = [\n'
        '  { id: "marlin", name: "Arch Linux", des: ["gnome"] },\n'
        '  // { id: "fake", name: "not real", des: ["gnome"] },\n'
        '];\n'
    )
    vc.APP_JS = app_js

    refs = vc.picker_refs()

    assert refs == [
        ("tuna-os/marlin:gnome", "app.js VARIANTS"),
        ("tuna-os/fake:gnome", "app.js VARIANTS"),
    ]


def test_picker_refs_exits_when_variants_block_missing(vc, tmp_path):
    app_js = tmp_path / "app.js"
    app_js.write_text("// no VARIANTS array here\n")
    vc.APP_JS = app_js

    with pytest.raises(SystemExit):
        vc.picker_refs()


# --- external_refs -----------------------------------------------------------


def test_external_refs_extracts_literal_image_strings(vc, tmp_path):
    catalog_go = tmp_path / "catalog.go"
    catalog_go.write_text(
        'package native\n\n'
        'var Catalog = []Entry{\n'
        '\t{ Image: "ghcr.io/projectbluefin/bluefin:stable" },\n'
        '\t{ Image: "ghcr.io/ublue-os/aurora:latest" },\n'
        '}\n'
    )
    vc.CATALOG_GO = catalog_go

    refs = vc.external_refs()

    assert refs == [
        ("projectbluefin/bluefin:stable", "catalog.go Image:"),
        ("ublue-os/aurora:latest", "catalog.go Image:"),
    ]


def test_external_refs_skips_generated_fmt_sprintf_entries(vc, tmp_path):
    catalog_go = tmp_path / "catalog.go"
    catalog_go.write_text(
        'package native\n\n'
        'Image: fmt.Sprintf("ghcr.io/tuna-os/%s:%s", v.id, de),\n'
        'Image: "ghcr.io/ublue-os/bazzite:latest",\n'
    )
    vc.CATALOG_GO = catalog_go

    refs = vc.external_refs()

    assert refs == [("ublue-os/bazzite:latest", "catalog.go Image:")]


def test_external_refs_empty_when_no_image_fields(vc, tmp_path):
    catalog_go = tmp_path / "catalog.go"
    catalog_go.write_text("package native\n")
    vc.CATALOG_GO = catalog_go

    assert vc.external_refs() == []


# --- pull_token --------------------------------------------------------------


def test_pull_token_returns_token_on_success(vc, monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"token": "abc123"}'

    monkeypatch.setattr(vc.urllib.request, "urlopen", lambda *a, **k: FakeResponse())

    assert vc.pull_token("tuna-os/marlin") == "abc123"


def test_pull_token_returns_none_on_url_error(vc, monkeypatch):
    def raise_url_error(*a, **k):
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(vc.urllib.request, "urlopen", raise_url_error)

    assert vc.pull_token("tuna-os/marlin") is None


def test_pull_token_returns_none_on_bad_json(vc, monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"not json"

    monkeypatch.setattr(vc.urllib.request, "urlopen", lambda *a, **k: FakeResponse())

    assert vc.pull_token("tuna-os/marlin") is None


# --- manifest_status -----------------------------------------------------------


def test_manifest_status_returns_404_without_retrying(vc, monkeypatch):
    monkeypatch.setattr(vc, "pull_token", lambda repo: "tok")
    monkeypatch.setattr(vc.time, "sleep", lambda s: None)
    calls = []

    def fake_urlopen(req, timeout):
        calls.append(req)
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(vc.urllib.request, "urlopen", fake_urlopen)

    status, reason = vc.manifest_status("tuna-os/flounder:niri")

    assert (status, reason) == (404, "")
    assert len(calls) == 1


def test_manifest_status_returns_200_on_success(vc, monkeypatch):
    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(vc, "pull_token", lambda repo: "tok")
    monkeypatch.setattr(vc.urllib.request, "urlopen", lambda req, timeout: FakeResponse())

    status, reason = vc.manifest_status("tuna-os/marlin:gnome")

    assert (status, reason) == (200, "")


def test_manifest_status_retries_then_gives_up_when_token_unobtainable(vc, monkeypatch):
    monkeypatch.setattr(vc, "pull_token", lambda repo: None)
    monkeypatch.setattr(vc.time, "sleep", lambda s: None)

    status, reason = vc.manifest_status("tuna-os/marlin:gnome")

    assert status is None
    assert "pull token" in reason


def test_manifest_status_retries_on_5xx_then_reports_inconclusive(vc, monkeypatch):
    monkeypatch.setattr(vc, "pull_token", lambda repo: "tok")
    monkeypatch.setattr(vc.time, "sleep", lambda s: None)
    attempts = []

    def fake_urlopen(req, timeout):
        attempts.append(1)
        raise urllib.error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)

    monkeypatch.setattr(vc.urllib.request, "urlopen", fake_urlopen)

    status, reason = vc.manifest_status("tuna-os/marlin:gnome")

    assert status is None
    assert reason == "HTTP 503"
    assert len(attempts) == vc.RETRIES


def test_manifest_status_retries_on_timeout(vc, monkeypatch):
    monkeypatch.setattr(vc, "pull_token", lambda repo: "tok")
    monkeypatch.setattr(vc.time, "sleep", lambda s: None)

    def fake_urlopen(req, timeout):
        raise TimeoutError("timed out")

    monkeypatch.setattr(vc.urllib.request, "urlopen", fake_urlopen)

    status, reason = vc.manifest_status("tuna-os/marlin:gnome")

    assert status is None
    assert "timed out" in reason


# --- main ----------------------------------------------------------------------


def test_main_returns_2_when_no_refs_parsed(vc, monkeypatch, capsys):
    monkeypatch.setattr(vc, "picker_refs", lambda: [])
    monkeypatch.setattr(vc, "external_refs", lambda: [])

    assert vc.main() == 2
    assert "zero refs" in capsys.readouterr().err


def test_main_returns_1_when_a_ref_is_missing(vc, monkeypatch, capsys):
    monkeypatch.setattr(vc, "picker_refs", lambda: [("tuna-os/flounder:niri", "app.js VARIANTS")])
    monkeypatch.setattr(vc, "external_refs", lambda: [])
    monkeypatch.setattr(vc, "manifest_status", lambda ref: (404, ""))

    assert vc.main() == 1
    out = capsys.readouterr().out
    assert "FAIL: 1 catalog ref(s)" in out


def test_main_returns_0_and_notes_inconclusive_refs_separately(vc, monkeypatch, capsys):
    refs = [
        ("tuna-os/marlin:gnome", "app.js VARIANTS"),
        ("ublue-os/aurora:latest", "catalog.go Image:"),
    ]
    monkeypatch.setattr(vc, "picker_refs", lambda: refs[:1])
    monkeypatch.setattr(vc, "external_refs", lambda: refs[1:])

    statuses = {"tuna-os/marlin:gnome": (200, ""), "ublue-os/aurora:latest": (None, "HTTP 503")}
    monkeypatch.setattr(vc, "manifest_status", lambda ref: statuses[ref])

    assert vc.main() == 0
    out = capsys.readouterr().out
    assert "did not resolve for reasons other than 404" in out
    assert "OK: 1 of 2 catalog refs resolved." in out
