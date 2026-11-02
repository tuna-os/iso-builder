"""Keep destructive USB setup distinct from copying onto existing media."""
from pathlib import Path
import re


HTML = (Path(__file__).resolve().parents[1] / "app/public/index.html").read_text()


def panel(name):
    match = re.search(rf'<div id="tab-{name}"[^>]*>(.*?)</div>', HTML, re.S)
    assert match, f"Missing {name} instructions"
    return match.group(1)


def test_ventoy_warns_before_install_and_distinguishes_existing_media():
    text = panel("ventoy")
    warning, steps = text.split("<ol", 1)
    assert "reformats" in warning and "erases all its data" in warning
    assert "Back up" in warning and "verify the target drive" in warning
    assert "non-destructive" not in text
    assert "already installed, do not reinstall" in steps
    assert "Copy your downloaded ISO file onto that data partition" in steps
    assert "free space exceeds the ISO file size" in steps
    assert "https://docs.projectbluefin.io/installation/" in warning
    assert "does not support Ventoy" in warning


def test_usb_capacity_depends_on_iso_size():
    text = panel("etcher")
    assert "capacity larger than the downloaded ISO file" in text
    assert "minimum 4GB" not in text
    assert "flashing erases its contents" in text
