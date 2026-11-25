"""scripts/generate-downloads.py: which published files the one-click page may link."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("generate_downloads", ROOT / "scripts/generate-downloads.py")
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)


def test_no_prebuilt_iso_is_ever_linked(tmp_path, monkeypatch):
    # R2 holds no ISOs: a link would be a 404 on the main button.
    out = tmp_path / "downloads.json"
    monkeypatch.setattr(gen, "fetch_json", lambda url, token=None: [])
    monkeypatch.setattr(gen.sys, "argv", ["generate-downloads.py", "--out", str(out)])
    assert gen.main() == 0
    doc = gen.json.loads(out.read_text())
    assert doc["schemaVersion"] == 1 and doc["prebuilt"] == {}


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


def test_only_trusted_signing_hides_the_first_launch_hint():
    rel = release("media-writer-v1.0.0", ["TunaOS-Media-Writer-macOS.dmg", "TunaOS-Media-Writer-Windows-x64.msi",
                                          "TunaOS-Media-Writer-Linux-x86_64.flatpak", "signing.json"])
    signing = {"schemaVersion": 1, "macos": "developer-id-notarized", "windows-x64": "unsigned", "linux-x86_64": "unsigned"}
    writer = gen.media_writer_from_releases([rel], fetch=lambda url: signing)
    assert {k: v["signed"] for k, v in writer["assets"].items()} == {"macos": True, "windows-x64": False, "linux-x86_64": False}

    def broken(url):
        raise OSError("404")
    for fetch in (broken, lambda url: {"macos": "adhoc"}):
        writer = gen.media_writer_from_releases([rel], fetch=fetch)
        assert not any(v["signed"] for v in writer["assets"].values())

    unsigned_release = release("media-writer-v1.0.0", ["TunaOS-Media-Writer-macOS.dmg"])
    assert gen.media_writer_from_releases([unsigned_release], fetch=broken)["assets"]["macos"]["signed"] is False
