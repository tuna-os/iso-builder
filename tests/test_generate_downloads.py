"""scripts/generate-downloads.py: which published files the one-click page may link."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("generate_downloads", ROOT / "scripts/generate-downloads.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

BASE = "https://download.tunaos.org/live-isos/"


def iso(name, arch="", latest=True, size=6_000_000_000, url=None):
    return {"name": name, "arch": arch, "latest": latest, "size": size, "url": url or f"{BASE}{name}.iso"}


def test_prebuilt_links_only_amd64_latest_live_isos():
    index = {"categories": [
        {"id": "live-isos", "isos": [
            iso("yellowfin-gnome-latest"),
            iso("bonito-kde-latest", arch="x86_64"),
            iso("bonito-kde-latest-arm64", arch="aarch64"),     # arm64 suffix after -latest
            iso("bonito-xfce-latest", arch="aarch64"),          # arm64 by field
            iso("bonito-niri-44-x86_64", latest=False),         # dated, not -latest
            iso("marlin-cosmic-latest", size=0),                # empty object
            iso("grouper-gnome-latest", url="https://evil.example/grouper-gnome-latest.iso"),
        ]},
        {"id": "other", "isos": [iso("albacore-latest")]},
    ]}
    assert gen.prebuilt_from_index(index) == {
        "bonito-kde": {"url": f"{BASE}bonito-kde-latest.iso", "size": 6_000_000_000, "modified": None},
        "yellowfin-gnome": {"url": f"{BASE}yellowfin-gnome-latest.iso", "size": 6_000_000_000, "modified": None},
    }


def release(tag, assets, draft=False, prerelease=False):
    return {"tag_name": tag, "draft": draft, "prerelease": prerelease, "assets": [
        {"name": name, "size": 1, "state": "uploaded",
         "browser_download_url": f"https://github.com/tuna-os/iso-builder/releases/download/{tag}/{name}"}
        for name in assets]}


def test_media_writer_uses_newest_published_release_with_known_assets():
    releases = [
        release("media-writer-v2.0.0", ["TunaOS-Media-Writer-macOS.dmg"], draft=True),
        release("media-writer-v1.9.0-rc1", ["TunaOS-Media-Writer-macOS.dmg"], prerelease=True),
        release("native-v5", ["TunaOS-Media-Writer-macOS.dmg"]),
        release("media-writer-v1.2.0", ["TunaOS-Media-Writer-Windows-x64.msi", "TunaOS-Media-Writer-Linux-x86_64.flatpak", "notes.txt"]),
        release("media-writer-v1.1.0", ["TunaOS-Media-Writer-macOS.dmg"]),
    ]
    writer = gen.media_writer_from_releases(releases)
    assert writer["version"] == "1.2.0"
    assert sorted(writer["assets"]) == ["linux-x86_64", "windows-x64"]


def test_no_media_writer_release_means_no_app_route():
    assert gen.media_writer_from_releases([release("v1", ["x.zip"])]) is None
