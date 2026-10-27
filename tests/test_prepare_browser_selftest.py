import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts/prepare-browser-selftest.py"
spec = importlib.util.spec_from_file_location("browser_selftest", SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def fixture(tmp_path):
    iso_bytes = b"round-tripped ISO bytes\n"
    iso = tmp_path / "skipjack-gnome.iso"
    iso.write_bytes(iso_bytes)
    source = digest(b"base-image")
    overlay = digest(b"live-overlay")
    engine = digest(b"tacklebox-executable")
    wasm = digest(b"browser-wasm")
    installer = digest(b"live-installer-bundle")
    measurements = {
        "schemaVersion": 1,
        "kind": "diagnostic-build-measurements",
        "qualification": "diagnostic-unqualified",
        "diagnosticUnqualified": {
            "label": "diagnostic, unqualified build",
            "image": "tuna-os/skipjack:gnome",
            "platform": "linux/amd64",
            "gateReason": "unqualified target",
        },
        "iso": {"sha256": digest(iso_bytes), "sizeBytes": len(iso_bytes)},
        "loadedWasm": {"sha256": wasm, "sizeBytes": 11},
        "engineBuildResult": {
            "bytesWritten": len(iso_bytes),
            "observedInputs": {
                "source": {"manifestDigest": source},
                "overlay": {"status": "applied", "manifestDigest": overlay,
                            "layersApplied": True, "baseAnnotationMatched": False},
            },
        },
        "browser": {"product": "HeadlessChrome/156.0.0.0", "userAgent": "fixture UA"},
        "phasesMs": {"inspect": 1, "build": 2, "save": 3},
        "missingIdentity": ["producer", "frontend"],
    }
    browser_evidence = {
        "schemaVersion": 1,
        "kind": "qualification-evidence",
        "half": "browser",
        "qualification": "diagnostic-unqualified",
        "diagnosticUnqualified": {
            "label": "diagnostic, unqualified build",
            "image": "tuna-os/skipjack:gnome",
            "platform": "linux/amd64",
        },
        "target": {"image": "tuna-os/skipjack:gnome", "platform": "linux/amd64"},
        "browser": {"name": "chromium", "userAgent": "fixture UA"},
        "run": {"sample": 1},
    }
    manifest = {
        "schemaVersion": 1,
        "kind": "candidate-iso-artifact-manifest",
        "qualification": "diagnostic-unqualified",
        "slug": "skipjack-gnome",
        "iso": measurements["iso"],
        "measurements": {key: measurements[key] for key in
                         ("iso", "loadedWasm", "browser", "phasesMs", "diagnosticUnqualified")},
        "producer": {"repository": "tuna-os/iso-builder", "runId": "12345",
                     "runAttempt": "2", "sha": "a" * 40},
    }
    source_receipt = {
        "base_image": "ghcr.io/tuna-os/skipjack:diagnostic",
        "base_digest": source,
        "overlay_digest": overlay,
        "engine_digest": engine,
        "platform": "linux/amd64",
    }
    args = {
        "iso": iso,
        "measurements": measurements,
        "browser_evidence": browser_evidence,
        "artifact_manifest": manifest,
        "source_receipt": source_receipt,
        "installer_digest": installer,
        "repository": "tuna-os/iso-builder",
        "run_id": "12345",
        "run_attempt": "2",
        "source_sha": "a" * 40,
        "artifact_id": "987654",
        "artifact_name": "iso-skipjack-gnome-run12345-a2",
        "variant": "skipjack",
        "flavor": "gnome",
        "slug": "skipjack-gnome",
        "platform": "linux/amd64",
    }
    return args, source, overlay, engine, wasm, installer


def test_binds_exact_round_trip_and_receipt_identities_without_qualifying(tmp_path):
    args, source, overlay, engine, wasm, installer = fixture(tmp_path)
    env, binding = helper.validate_inputs(**args)

    assert env["TUNAOS_QUAL_MEDIA_DIGEST"] == digest(args["iso"].read_bytes())
    assert env["TUNAOS_QUAL_SOURCE_REF"] == "ghcr.io/tuna-os/skipjack:diagnostic"
    assert env["TUNAOS_QUAL_SOURCE_DIGEST"] == source
    assert env["TUNAOS_QUAL_OVERLAY_DIGEST"] == overlay
    assert env["TUNAOS_QUAL_INSTALLER_DIGEST"] == installer
    assert env["TUNAOS_QUAL_ENGINE_DIGEST"] == engine
    assert env["TUNAOS_QUAL_ENGINE_DIGEST"] != wasm
    assert env["TUNAOS_QUAL_BROWSER_VERSION"] == "156.0.0.0"
    assert env["TUNAOS_QUAL_CPU_BASELINE"] == "x86-64"
    assert binding["qualification"] == "diagnostic-unqualified"
    assert binding["identities"]["overlayBaseAnnotationMatched"] is False
    assert binding["producer"]["artifactId"] == 987654
    assert binding["missingBrowserIdentity"] == ["producer", "frontend"]


def test_rejects_round_trip_bytes_changed_without_size_change(tmp_path):
    args, *_ = fixture(tmp_path)
    changed = bytearray(args["iso"].read_bytes())
    changed[0] ^= 1
    args["iso"].write_bytes(changed)

    with pytest.raises(helper.InputError, match="round-tripped ISO differs"):
        helper.validate_inputs(**args)


def test_rejects_media_source_that_disagrees_with_engine_observation(tmp_path):
    args, *_ = fixture(tmp_path)
    args["source_receipt"]["base_digest"] = digest(b"other source")
    args["source_receipt"]["base_image"] = f"ghcr.io/tuna-os/skipjack@{digest(b'other source')}"

    with pytest.raises(helper.InputError, match="media source digest differs"):
        helper.validate_inputs(**args)


def test_rejects_manifest_from_another_run_attempt(tmp_path):
    args, *_ = fixture(tmp_path)
    args["artifact_manifest"]["producer"]["runAttempt"] = "1"

    with pytest.raises(helper.InputError, match="producer differs"):
        helper.validate_inputs(**args)


def test_installer_identity_must_come_from_valid_media_receipt():
    assert helper.parse_installer_receipt("INSTALLER_BUNDLE_SHA256=" + "A" * 64 + "\n") == "sha256:" + "a" * 64
    assert helper.parse_installer_receipt(
        "INSTALLER_BUNDLE_SHA256=placeholder\nINSTALLER_REVISION=" + "B" * 64 + "\n"
    ) == "sha256:" + "b" * 64
    with pytest.raises(helper.InputError, match="lacks a valid"):
        helper.parse_installer_receipt("INSTALLER_REVISION=not-a-digest\n")
    with pytest.raises(helper.InputError, match="repeats"):
        helper.parse_installer_receipt("INSTALLER_BUNDLE_SHA256=" + "a" * 64 + "\nINSTALLER_BUNDLE_SHA256=" + "b" * 64)


def test_main_retains_bounded_payload_format_and_receipt_errors(tmp_path, monkeypatch, capsys):
    iso = tmp_path / "fixture.iso"
    iso.write_bytes(b"not a real ISO; extraction is isolated below")
    extractor = tmp_path / "payload-extractor.py"
    extractor.write_text(
        "from pathlib import Path\n"
        "import sys\n"
        "destination = Path(sys.argv[2])\n"
        "for name in ('missing.squashfs', 'invalid.squashfs'):\n"
        "    payload = destination / name\n"
        "    payload.write_bytes(b'fixture')\n"
        "    print(payload)\n",
        encoding="utf-8",
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "unsquashfs").write_text(
        "#!/usr/bin/env python3\n"
        "from pathlib import Path\n"
        "import sys\n"
        "args = sys.argv[1:]\n"
        "if args[0] == '-s':\n"
        "    if Path(args[1]).name == 'invalid.squashfs':\n"
        "        print(\"Can't find a valid SQUASHFS superblock \" + 'x' * 1000 + '\\x1b[31m', file=sys.stderr)\n"
        "        raise SystemExit(1)\n"
        "    print('Found a valid SQUASHFS 4:0 superblock, compression lz4')\n"
        "    raise SystemExit(0)\n"
        "if args[0] == '-cat':\n"
        "    if Path(args[1]).name == 'missing.squashfs':\n"
        "        print('file not found: ' + args[2] + ' ' + 'y' * 1000, file=sys.stderr)\n"
        "    else:\n"
        "        print('not a squashfs ' + 'z' * 1000, file=sys.stderr)\n"
        "    raise SystemExit(1)\n"
        "raise SystemExit(2)\n",
        encoding="utf-8",
    )
    (bin_dir / "unsquashfs").chmod(0o755)
    monkeypatch.setenv("PATH", os.pathsep.join([str(bin_dir), os.environ.get("PATH", "")]))

    diagnostics = tmp_path / "out" / "receipt-probes.log"
    out_env = tmp_path / "out" / "same-byte.env"
    out_binding = tmp_path / "out" / "binding.json"
    assert helper.main([
        "--iso", str(iso),
        "--measurements", str(tmp_path / "not-read-measurements.json"),
        "--browser-evidence", str(tmp_path / "not-read-browser.json"),
        "--manifest", str(tmp_path / "not-read-manifest.json"),
        "--payload-extractor", str(extractor),
        "--repository", "tuna-os/iso-builder", "--run-id", "1", "--run-attempt", "1",
        "--source-sha", "a" * 40, "--artifact-id", "2",
        "--artifact-name", "iso-skipjack-gnome-run1-a1",
        "--variant", "skipjack", "--flavor", "gnome", "--slug", "skipjack-gnome",
        "--platform", "linux/amd64", "--out-env", str(out_env),
        "--out-binding", str(out_binding), "--out-diagnostics", str(diagnostics),
    ]) == 1

    assert "bounded receipt diagnostics" in capsys.readouterr().err
    assert not out_env.exists() and not out_binding.exists()
    report = json.loads(diagnostics.read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert report["qualification"] == "diagnostic-unqualified"
    assert report["extractor"]["payloadCount"] == 2
    missing, invalid = report["payloads"]
    assert missing["path"] == "missing.squashfs"
    assert missing["filesystem"]["status"] == "ok"
    assert "SQUASHFS 4:0" in missing["filesystem"]["summary"]
    source_probe = missing["members"]["etc/tunaos/live-source.json"]
    assert source_probe["status"] == "error" and "file not found" in source_probe["stderr"]
    assert invalid["path"] == "invalid.squashfs"
    assert invalid["filesystem"]["status"] == "error"
    format_error = invalid["filesystem"]["stderr"]
    assert "Can't find a valid SQUASHFS superblock" in format_error
    assert "...[truncated]" in format_error and "\x1b" not in format_error
    assert len(format_error) <= helper.MAX_DIAGNOSTIC_CHARS + len("...[truncated]")
