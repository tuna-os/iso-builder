import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

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
    # A browser build's engine is the WASM module it loaded (RFC 014).
    engine = digest(b"browser-wasm")
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
    assert env["TUNAOS_QUAL_ENGINE_DIGEST"] == engine == wasm
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


def test_rejects_receipt_engine_that_is_not_the_loaded_wasm(tmp_path):
    args, *_ = fixture(tmp_path)
    args["source_receipt"]["engine_digest"] = digest(b"tacklebox-executable")

    with pytest.raises(helper.InputError, match="engine digest differs from the loaded WASM"):
        helper.validate_inputs(**args)


def engine_receipt(source, overlay, engine):
    return {"base_image": "tuna-os/skipjack:gnome", "base_digest": source,
            "overlay_digest": overlay, "engine_digest": engine, "platform": "linux/amd64",
            "installer_app_id": "org.bootcinstaller.Installer",
            "installer_revision": "c" * 64, "installer_bundle_sha256": "remote"}


def erofs_image(tmp_path, receipt_text, *options):
    tree = tmp_path / "tree"
    (tree / "etc/tunaos").mkdir(parents=True)
    (tree / "usr/lib").mkdir(parents=True)
    (tree / "usr/lib/os-release").write_text("ID=tunaos\n")
    if receipt_text is not None:
        (tree / "etc/tunaos/live-source.json").write_text(receipt_text)
    (tree / "etc/tunaos/live-installer-info").write_text("INSTALLER_REVISION=" + "c" * 64 + "\n")
    image = tmp_path / "rootfs.sfs"
    subprocess.run(["mkfs.erofs", *options, str(image), str(tree)], check=True, capture_output=True)
    return image


needs_mkfs_erofs = pytest.mark.skipif(shutil.which("mkfs.erofs") is None, reason="mkfs.erofs not installed")


@needs_mkfs_erofs
@pytest.mark.parametrize("options", [(), ("-Enoinline_data",)], ids=["flat-inline", "flat-plain"])
def test_reads_engine_receipt_from_browser_erofs_live_root(tmp_path, options):
    args, source, overlay, engine, *_ = fixture(tmp_path)
    receipt = engine_receipt(source, overlay, engine)
    image = erofs_image(tmp_path, json.dumps(receipt, indent=2) + "\n", *options)

    assert helper.is_erofs(image)
    assert json.loads(helper.cat_payload_member(image, "etc/tunaos/live-source.json")) == receipt
    assert helper.cat_payload_member(image, "etc/tunaos/missing.json") is None
    with pytest.raises(helper.InputError, match="crosses a non-directory"):
        helper.cat_payload_member(image, "usr/lib/os-release/x")
    args["source_receipt"] = json.loads(helper.cat_payload_member(image, "etc/tunaos/live-source.json"))
    env, _ = helper.validate_inputs(**args)
    assert (env["TUNAOS_QUAL_SOURCE_DIGEST"], env["TUNAOS_QUAL_OVERLAY_DIGEST"],
            env["TUNAOS_QUAL_ENGINE_DIGEST"]) == (source, overlay, engine)


@needs_mkfs_erofs
@pytest.mark.parametrize("field,value,error", [
    ("overlay_digest", "unknown", "missing or invalid identity fields"),
    ("engine_digest", digest(b"tacklebox-executable"), "engine digest differs"),
    ("base_digest", digest(b"other base"), "media source digest differs"),
    ("overlay_digest", digest(b"other overlay"), "media overlay digest differs"),
    ("platform", "linux/arm64", "media platform differs"),
])
def test_rejects_tampered_erofs_receipt(tmp_path, field, value, error):
    args, source, overlay, engine, *_ = fixture(tmp_path)
    receipt = engine_receipt(source, overlay, engine)
    receipt[field] = value
    image = erofs_image(tmp_path, json.dumps(receipt))
    args["source_receipt"] = json.loads(helper.cat_payload_member(image, "etc/tunaos/live-source.json"))

    with pytest.raises(helper.InputError, match=error):
        helper.validate_inputs(**args)


@needs_mkfs_erofs
def test_erofs_live_root_without_receipt_is_absent(tmp_path):
    image = erofs_image(tmp_path, None)
    assert helper.cat_payload_member(image, "etc/tunaos/live-source.json") is None


def test_installer_identity_must_come_from_valid_media_receipt():
    assert helper.parse_installer_receipt("INSTALLER_BUNDLE_SHA256=" + "A" * 64 + "\n") == "sha256:" + "a" * 64
    assert helper.parse_installer_receipt(
        "INSTALLER_BUNDLE_SHA256=placeholder\nINSTALLER_REVISION=" + "B" * 64 + "\n"
    ) == "sha256:" + "b" * 64
    with pytest.raises(helper.InputError, match="lacks a valid"):
        helper.parse_installer_receipt("INSTALLER_REVISION=not-a-digest\n")
    with pytest.raises(helper.InputError, match="repeats"):
        helper.parse_installer_receipt("INSTALLER_BUNDLE_SHA256=" + "a" * 64 + "\nINSTALLER_BUNDLE_SHA256=" + "b" * 64)


@pytest.mark.parametrize("origin,expected", [
    (("tuna-os/iso-builder", "12345", "2"), True),
    (("tuna-os/iso-builder", "12346", "2"), False),
    (("tuna-os/iso-builder", "12345", "3"), False),
    (("other/repository", "12345", "2"), False),
    ((None, None, None), False),
])
def test_host_measurement_origin_matches_producer_run(tmp_path, origin, expected):
    args, *_ = fixture(tmp_path)
    _, binding = helper.validate_inputs(
        **args, measurement_repository=origin[0], measurement_run_id=origin[1],
        measurement_run_attempt=origin[2])
    profile = binding["hostProfile"]
    assert profile["measuredOnBrowserRunner"] is expected
    assert profile["measurementOrigin"] == ("producer-run" if expected else "recovery-host")
    assert profile["memoryGiB"] > 0
    assert profile["freeDiskGiB"] > 0
