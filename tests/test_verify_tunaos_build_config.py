"""Unit tests for scripts/verify-tunaos-build-config.py.

Same shape as tests/test_verify_catalog.py: cover the parsers and the
main()/exit-code contract in isolation, without touching the real network
or this repo's actual native/catalog.go.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = (
    Path(__file__).resolve().parent.parent / "scripts" / "verify-tunaos-build-config.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("verify_tunaos_build_config", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def vtbc():
    return _load_module()


# --- parse_catalog_go --------------------------------------------------------


def test_parse_catalog_go_extracts_variant_desktop_sets(vtbc, tmp_path):
    catalog_go = tmp_path / "catalog.go"
    catalog_go.write_text(
        'var variants = []variant{\n'
        '\t{"yellowfin", "AlmaLinux Kitten 10 (flagship)", []string{"gnome", "kde", "cosmic", "niri"}},\n'
        '\t{"guppy", "Gentoo (source-based)", []string{"gnome", "kde"}},\n'
        '}\n'
    )
    vtbc.CATALOG_GO = catalog_go

    assert vtbc.parse_catalog_go() == {
        "yellowfin": {"gnome", "kde", "cosmic", "niri"},
        "guppy": {"gnome", "kde"},
    }


def test_parse_catalog_go_empty_when_no_variants(vtbc, tmp_path):
    catalog_go = tmp_path / "catalog.go"
    catalog_go.write_text("package main\n")
    vtbc.CATALOG_GO = catalog_go

    assert vtbc.parse_catalog_go() == {}


# --- parse_build_config -------------------------------------------------------


def test_parse_build_config_only_counts_build_image_true_desktops(vtbc):
    text = """
variants:
  - id: flounder
    description: "Based on Debian 13 Trixie"
    flavors:
      - id: base
        stage: 1
        build_image: true
      - id: gnome
        stage: 2
        build_image: false
      - id: kde
        stage: 2
        build_image: true
      - id: xfce
        stage: 2
        build_image: true
"""
    assert vtbc.parse_build_config(text) == {"flounder": {"kde", "xfce"}}


def test_parse_build_config_drops_experimental_variants(vtbc):
    text = """
variants:
  - id: wahoo
    experimental: true
    flavors:
      - id: gnome
        build_image: true
  - id: yellowfin
    flavors:
      - id: gnome
        build_image: true
"""
    result = vtbc.parse_build_config(text)
    assert "wahoo" not in result
    assert result == {"yellowfin": {"gnome"}}


def test_parse_build_config_ignores_sibling_images(vtbc):
    """sibling_images: entries (tromso, xfce-linux) are separate repos, not
    part of this catalog — must never leak into the comparison."""
    text = """
sibling_images:
  - id: tromso
    desktops: [KDE]
variants:
  - id: yellowfin
    flavors:
      - id: gnome
        build_image: true
"""
    assert vtbc.parse_build_config(text) == {"yellowfin": {"gnome"}}


def test_parse_build_config_ignores_non_desktop_flavors(vtbc):
    """base/hwe/nvidia/asahi flavors aren't in DESKTOP_IDS and must not
    show up as phantom desktops."""
    text = """
variants:
  - id: yellowfin
    flavors:
      - id: base
        build_image: true
      - id: gnome-nvidia
        build_image: true
      - id: gnome
        build_image: true
"""
    assert vtbc.parse_build_config(text) == {"yellowfin": {"gnome"}}


def test_parse_build_config_empty_on_no_variants_key(vtbc):
    assert vtbc.parse_build_config("config:\n  global_platforms: []\n") == {}


# --- main ----------------------------------------------------------------------


def test_main_returns_2_when_catalog_go_parses_empty(vtbc, monkeypatch, capsys):
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {})

    assert vtbc.main() == 2
    assert "zero variants from native/catalog.go" in capsys.readouterr().err


def test_main_returns_0_when_fetch_fails(vtbc, monkeypatch, capsys):
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {"yellowfin": {"gnome"}})
    monkeypatch.setattr(vtbc, "fetch", lambda url: None)

    assert vtbc.main() == 0
    assert "Not treated as a failure" in capsys.readouterr().out


def test_main_returns_2_when_build_config_parses_empty(vtbc, monkeypatch, capsys):
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {"yellowfin": {"gnome"}})
    monkeypatch.setattr(vtbc, "fetch", lambda url: "variants:\n")
    monkeypatch.setattr(vtbc, "parse_build_config", lambda text: {})

    assert vtbc.main() == 2
    assert "zero variants from tunaOS's build-config.yml" in capsys.readouterr().err


def test_main_fails_on_extra_cell_not_built_upstream(vtbc, monkeypatch, capsys):
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {"guppy": {"gnome", "kde"}})
    monkeypatch.setattr(vtbc, "fetch", lambda url: "raw text")
    monkeypatch.setattr(vtbc, "parse_build_config", lambda text: {"guppy": {"kde"}})

    assert vtbc.main() == 1
    out = capsys.readouterr().out
    assert "EXTRA" in out
    assert "guppy:gnome" in out


def test_main_reports_missing_without_failing(vtbc, monkeypatch, capsys):
    """build_image:true upstream but not offered here is informational only
    — iso-builder#142 left the coverage contract as an open product
    decision, so this must not fail the run."""
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {"yellowfin": {"gnome"}})
    monkeypatch.setattr(vtbc, "fetch", lambda url: "raw text")
    monkeypatch.setattr(
        vtbc, "parse_build_config", lambda text: {"yellowfin": {"gnome", "xfce"}}
    )

    assert vtbc.main() == 0
    out = capsys.readouterr().out
    assert "MISSING" in out
    assert "yellowfin:xfce" in out


def test_main_returns_0_when_everything_matches(vtbc, monkeypatch, capsys):
    monkeypatch.setattr(vtbc, "parse_catalog_go", lambda: {"yellowfin": {"gnome"}})
    monkeypatch.setattr(vtbc, "fetch", lambda url: "raw text")
    monkeypatch.setattr(vtbc, "parse_build_config", lambda text: {"yellowfin": {"gnome"}})

    assert vtbc.main() == 0
    assert "OK: every cell" in capsys.readouterr().out
