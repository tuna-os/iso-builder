from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

import pytest

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts/prepare-browser-selftest.py"
spec = importlib.util.spec_from_file_location("browser_selftest", SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def fixture(tmp_path, diagnostic=True):
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
        "install_mode": "luks" if diagnostic else "plain",
        "diagnostic_unqualified": diagnostic,
    }
    if not diagnostic:
        measurements["qualification"] = manifest["qualification"] = "not-assessed"
        del measurements["diagnosticUnqualified"]
        del manifest["measurements"]["diagnosticUnqualified"]
        del browser_evidence["diagnosticUnqualified"]
        del browser_evidence["qualification"]
    # Separate JSON inputs cannot share references at the real boundary.
    args["artifact_manifest"] = deepcopy(manifest)
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
    assert env["STRICT_INSTALL_MODE"] == "luks"
    assert env["DIAGNOSTIC_UNQUALIFIED"] == "true"
    assert env["TUNAOS_INSTALLED_BOOT_DIAGNOSTIC"] == "1"
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


@pytest.mark.parametrize("field", [
    "base_image", "base_digest", "overlay_digest", "engine_digest", "platform",
])
def test_rejects_incomplete_media_receipt(tmp_path, field):
    args, *_ = fixture(tmp_path)
    del args["source_receipt"][field]

    with pytest.raises(helper.InputError, match="missing or invalid identity fields"):
        helper.validate_inputs(**args)


def test_observed_plain_is_not_assessed_and_keeps_identity_limits(tmp_path):
    args, source, overlay, engine, wasm, installer = fixture(tmp_path, diagnostic=False)
    env, binding = helper.validate_inputs(**args)

    assert env["STRICT_INSTALL_MODE"] == "plain"
    assert env["DIAGNOSTIC_UNQUALIFIED"] == "false"
    assert env["TUNAOS_INSTALLED_BOOT_DIAGNOSTIC"] == "0"
    assert env["TUNAOS_QUAL_SOURCE_DIGEST"] == source
    assert env["TUNAOS_QUAL_OVERLAY_DIGEST"] == overlay
    assert env["TUNAOS_QUAL_ENGINE_DIGEST"] == engine == wasm
    assert env["TUNAOS_QUAL_INSTALLER_DIGEST"] == installer
    assert binding["qualification"] == "not-assessed"
    assert "fullQualificationEvidence" not in binding
    assert binding["missingBrowserIdentity"] == ["producer", "frontend"]


@pytest.mark.parametrize("component", ["measurements", "browser_evidence", "artifact_manifest"])
@pytest.mark.parametrize("diagnostic", [False, True], ids=["observed", "diagnostic"])
def test_rejects_input_label_that_disagrees_with_requested_diagnostic_flag(tmp_path, component, diagnostic):
    args, *_ = fixture(tmp_path, diagnostic=diagnostic)
    args[component]["qualification"] = "not-assessed" if diagnostic else "diagnostic-unqualified"
    with pytest.raises(helper.InputError, match="qualification|diagnostic"):
        helper.validate_inputs(**args)


@pytest.mark.parametrize("component", ["measurements", "browser_evidence", "artifact_manifest"])
@pytest.mark.parametrize("diagnostic", [False, True], ids=["observed", "diagnostic"])
def test_single_mode_observation_rejects_qualified_input(tmp_path, component, diagnostic):
    args, *_ = fixture(tmp_path, diagnostic=diagnostic)
    args[component]["qualification"] = "qualified"
    with pytest.raises(helper.InputError):
        helper.validate_inputs(**args)


def test_observed_plain_accepts_explicit_not_assessed_browser_evidence(tmp_path):
    args, *_ = fixture(tmp_path, diagnostic=False)
    args["browser_evidence"]["qualification"] = "not-assessed"

    _, binding = helper.validate_inputs(**args)

    assert binding["qualification"] == "not-assessed"
    assert "qualificationId" not in binding
    assert "fullQualificationEvidence" not in binding


@pytest.mark.parametrize("component", ["measurements", "browser_evidence"])
@pytest.mark.parametrize("stale_block", [None, False, {}, {
    "label": "diagnostic, unqualified build", "image": "tuna-os/skipjack:gnome", "platform": "linux/amd64",
}])
def test_observed_plain_rejects_old_or_contradictory_diagnostic_block(tmp_path, component, stale_block):
    args, *_ = fixture(tmp_path, diagnostic=False)
    args[component]["diagnosticUnqualified"] = stale_block
    with pytest.raises(helper.InputError, match="diagnostic"):
        helper.validate_inputs(**args)


@pytest.mark.parametrize("diagnostic,mode", [(True, "plain"), (True, "both"), (False, "luks"),
                                              (False, "plain,luks"), (False, "")])
def test_rejects_install_mode_outside_requested_diagnostic_context(tmp_path, diagnostic, mode):
    args, *_ = fixture(tmp_path, diagnostic=diagnostic)
    args["install_mode"] = mode
    with pytest.raises(helper.InputError):
        helper.validate_inputs(**args)


def test_observed_both_mode_binds_the_same_identities_and_records_the_mode(tmp_path):
    args, source, overlay, engine, wasm, installer = fixture(tmp_path, diagnostic=False)
    plain_env, plain_binding = helper.validate_inputs(**args)
    args["install_mode"] = "both"
    env, binding = helper.validate_inputs(**args)

    assert env["STRICT_INSTALL_MODE"] == "both"
    assert env["DIAGNOSTIC_UNQUALIFIED"] == "false"
    assert env["TUNAOS_INSTALLED_BOOT_DIAGNOSTIC"] == "0"
    volatile = {"STRICT_INSTALL_MODE", "TUNAOS_QUAL_BROWSER_FREE_DISK_GIB"}
    assert {k: v for k, v in env.items() if k not in volatile} == \
        {k: v for k, v in plain_env.items() if k not in volatile}
    assert binding["qualification"] == "not-assessed"
    assert binding["installMode"] == "both" and plain_binding["installMode"] == "plain"
    assert binding["identities"] == plain_binding["identities"]
    assert binding["notice"].startswith("Both-mode observation")


@pytest.mark.parametrize("field,value", [
    ("repository", "another/repository"), ("runId", "12344"),
    ("runAttempt", "1"), ("sha", "b" * 40),
])
@pytest.mark.parametrize("diagnostic", [False, True])
def test_rejects_stale_artifact_producer_identity(tmp_path, field, value, diagnostic):
    args, *_ = fixture(tmp_path, diagnostic=diagnostic)
    args["artifact_manifest"]["producer"][field] = value
    with pytest.raises(helper.InputError, match="producer differs"):
        helper.validate_inputs(**args)


@pytest.mark.parametrize("field,value", [
    ("artifact_id", "0"), ("artifact_name", "iso-skipjack-gnome-run12345-a1"),
])
def test_observed_plain_rejects_wrong_uploaded_artifact_identity(tmp_path, field, value):
    args, *_ = fixture(tmp_path, diagnostic=False)
    args[field] = value
    with pytest.raises(helper.InputError, match="artifact"):
        helper.validate_inputs(**args)


@pytest.mark.parametrize("section,field,value", [
    ("browser", "userAgent", "another browser session"),
    ("browser", "name", "firefox"), ("run", "sample", 2),
    ("target", "image", "tuna-os/bonito:gnome"),
    ("target", "platform", "linux/arm64"),
])
@pytest.mark.parametrize("diagnostic", [False, True])
def test_rejects_browser_half_identity_mismatch(tmp_path, section, field, value, diagnostic):
    args, *_ = fixture(tmp_path, diagnostic=diagnostic)
    args["browser_evidence"][section][field] = value
    with pytest.raises(helper.InputError, match="browser evidence"):
        helper.validate_inputs(**args)


@pytest.mark.parametrize("field,value,error", [
    ("base_digest", digest(b"another base"), "media source digest differs"),
    ("overlay_digest", digest(b"another overlay"), "media overlay digest differs"),
    ("engine_digest", digest(b"backend executable"), "engine digest differs"),
])
def test_observed_plain_rejects_media_identity_mismatch(tmp_path, field, value, error):
    args, *_ = fixture(tmp_path, diagnostic=False)
    args["source_receipt"][field] = value
    with pytest.raises(helper.InputError, match=error):
        helper.validate_inputs(**args)


def test_backend_binary_hash_is_not_an_installer_receipt():
    with pytest.raises(helper.InputError, match="lacks a valid"):
        helper.parse_installer_receipt("INSTALLER_BACKEND_SHA256=" + "a" * 64 + "\n")


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


@needs_mkfs_erofs
def test_extraction_reads_erofs_payload_and_records_it_in_diagnostics(tmp_path):
    args, source, overlay, engine, *_ = fixture(tmp_path)
    receipt = engine_receipt(source, overlay, engine)
    image = erofs_image(tmp_path, json.dumps(receipt))
    extractor = tmp_path / "extractor.py"
    extractor.write_text(
        "from pathlib import Path\nimport shutil, sys\n"
        "out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)\n"
        f"target = out / 'rootfs.erofs'; shutil.copyfile({str(image)!r}, target); print(target)\n",
        encoding="utf-8",
    )
    diagnostics = {}

    found_source, installer = helper.extract_media_receipts(
        args["iso"], extractor, tmp_path / "out", diagnostics)

    assert found_source == receipt
    assert installer == "sha256:" + "c" * 64
    (record,) = diagnostics["payloads"]
    assert record["filesystem"] == {"status": "ok", "type": "erofs"}
    assert record["members"]["etc/tunaos/live-source.json"]["status"] == "present"



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
        "if args[0] == '-ls':\n"
        "    print('squashfs-root')\n"
        "    raise SystemExit(0)\n"
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
    assert source_probe["status"] == "absent"
    assert invalid["path"] == "invalid.squashfs"
    assert invalid["filesystem"]["status"] == "error"
    format_error = invalid["filesystem"]["stderr"]
    assert "Can't find a valid SQUASHFS superblock" in format_error
    assert "...[truncated]" in format_error and "\x1b" not in format_error
    assert len(format_error) <= helper.MAX_DIAGNOSTIC_CHARS + len("...[truncated]")


def install_fake_unsquashfs(tmp_path, monkeypatch, script):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    executable = bin_dir / "unsquashfs"
    executable.write_text("#!/usr/bin/env python3\n" + script, encoding="utf-8")
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", os.pathsep.join([str(bin_dir), os.environ.get("PATH", "")]))


def test_squashfs_timeout_diagnostic_excludes_partial_member_stdout(tmp_path, monkeypatch):
    install_fake_unsquashfs(
        tmp_path, monkeypatch,
        "import sys, time\n"
        "sys.stdout.write('PRIVATE_RECEIPT_CONTENT')\n"
        "sys.stdout.flush()\n"
        "time.sleep(2)\n",
    )
    monkeypatch.setattr(helper, "SQUASHFS_PROBE_TIMEOUT_SECONDS", 0.05)

    result, diagnostic = helper.run_squashfs_probe(["-cat", "payload.squashfs", "etc/tunaos/live-source.json"])

    assert result is None
    assert diagnostic == {"status": "timeout", "detail": ""}


def test_squashfs_probe_bounds_captured_output(tmp_path, monkeypatch):
    install_fake_unsquashfs(
        tmp_path, monkeypatch,
        "import sys, time\n"
        f"sys.stdout.buffer.write(b'x' * ({helper.MAX_SQUASHFS_PROBE_OUTPUT_BYTES} + 8192))\n"
        "sys.stdout.flush()\n"
        "time.sleep(2)\n",
    )

    result, diagnostic = helper.run_squashfs_probe(["-cat", "payload.squashfs", "etc/tunaos/live-source.json"])

    assert result is None
    assert diagnostic["status"] == "output-limit"
    assert len(diagnostic["detail"]) <= helper.MAX_DIAGNOSTIC_CHARS


def test_member_probe_timeout_fails_even_when_another_payload_has_valid_receipts(tmp_path, monkeypatch):
    iso = tmp_path / "fixture.iso"
    iso.write_bytes(b"fixture")
    extractor = tmp_path / "payload-extractor.py"
    extractor.write_text(
        "from pathlib import Path\n"
        "import sys\n"
        "destination = Path(sys.argv[2])\n"
        "destination.mkdir(parents=True, exist_ok=True)\n"
        "for name in ('first.squashfs', 'second.squashfs'):\n"
        "    payload = destination / name\n"
        "    payload.write_bytes(b'fixture')\n"
        "    print(payload)\n",
        encoding="utf-8",
    )
    source = {
        "base_image": "ghcr.io/tuna-os/skipjack:diagnostic",
        "base_digest": digest(b"base"),
        "overlay_digest": digest(b"overlay"),
        "engine_digest": digest(b"engine"),
        "platform": "linux/amd64",
    }
    source_text = json.dumps(source)
    installer_text = "INSTALLER_BUNDLE_SHA256=" + digest(b"installer").removeprefix("sha256:") + "\n"

    def probe(arguments):
        if arguments[0] == "-s":
            result = subprocess.CompletedProcess(arguments, 0, "Found SQUASHFS 4:0 superblock", "")
            return result, {"status": "ok", "exitCode": 0}
        if arguments[0] == "-ls":
            if Path(arguments[-2]).name != "first.squashfs":
                return None, {"status": "timeout", "detail": ""}
            text = "squashfs-root/" + arguments[-1] + "\n"
        else:
            text = source_text if arguments[-1] == "etc/tunaos/live-source.json" else installer_text
        result = subprocess.CompletedProcess(arguments, 0, text, "")
        return result, {"status": "ok", "exitCode": 0}

    monkeypatch.setattr(helper, "run_squashfs_probe", probe)
    diagnostics = {}
    with pytest.raises(helper.InputError, match="receipt member probe did not complete"):
        helper.extract_media_receipts(iso, extractor, tmp_path / "payloads", diagnostics)

    assert diagnostics["payloads"][0]["members"]["etc/tunaos/live-source.json"]["status"] == "present"
    assert diagnostics["payloads"][1]["members"]["etc/tunaos/live-source.json"]["status"] == "timeout"


def test_too_many_payloads_fail_before_any_member_probes(tmp_path, monkeypatch):
    iso = tmp_path / "fixture.iso"
    iso.write_bytes(b"fixture")
    extractor = tmp_path / "payload-extractor.py"
    extractor.write_text(
        "from pathlib import Path\n"
        "import sys\n"
        "destination = Path(sys.argv[2])\n"
        f"for index in range({helper.MAX_DIAGNOSTIC_PAYLOADS + 1}):\n"
        "    print(destination / f'payload-{index}.squashfs')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(helper, "run_squashfs_probe",
                        lambda *_: pytest.fail("must reject payload count before probing"))
    diagnostics = {}

    with pytest.raises(helper.InputError, match="too many live filesystem payloads"):
        helper.extract_media_receipts(iso, extractor, tmp_path / "payloads", diagnostics)

    assert diagnostics["payloadsTruncated"] is True
    assert diagnostics["payloads"] == []


def test_extractor_output_limit_fails_before_payload_processing(tmp_path, monkeypatch):
    iso = tmp_path / "fixture.iso"
    iso.write_bytes(b"fixture")
    extractor = tmp_path / "payload-extractor.py"
    extractor.write_text(
        "import sys, time\n"
        f"sys.stdout.write('x' * ({helper.MAX_EXTRACTOR_OUTPUT_BYTES} + 8192))\n"
        "sys.stdout.flush()\n"
        "time.sleep(2)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(helper, "run_squashfs_probe",
                        lambda *_: pytest.fail("must reject extractor output before probing"))
    diagnostics = {}

    with pytest.raises(helper.InputError, match="ISO payload extractor did not complete"):
        helper.extract_media_receipts(iso, extractor, tmp_path / "payloads", diagnostics)

    assert diagnostics["extractor"]["status"] == "output-limit"
    assert len(diagnostics["extractor"]["detail"]) <= helper.MAX_DIAGNOSTIC_CHARS


@pytest.mark.skipif(os.name != "posix" or not Path("/proc").exists(),
                    reason="process group cleanup is verified on Linux runners")
def test_bounded_extractor_timeout_kills_descendant_processes(tmp_path):
    pid_file = tmp_path / "child.pid"
    script = (
        "import pathlib, subprocess, sys, time\n"
        f"pid_file = pathlib.Path({str(pid_file)!r})\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "pid_file.write_text(str(child.pid))\n"
        "time.sleep(60)\n"
    )

    result, diagnostic = helper.run_bounded_command(
        [helper.sys.executable, "-c", script], timeout=1, output_limit=1024,
    )

    assert result is None
    assert diagnostic["status"] == "timeout"
    child_pid = int(pid_file.read_text(encoding="utf-8"))
    stat_path = Path(f"/proc/{child_pid}/stat")
    deadline = time.monotonic() + 2
    while True:
        try:
            state = stat_path.read_text(encoding="utf-8").split(") ", 1)[1].split(" ", 1)[0]
        except FileNotFoundError:
            break
        if state == "Z":
            break
        if time.monotonic() >= deadline:
            pytest.fail("descendant process survived bounded command timeout")
        time.sleep(0.01)


@pytest.fixture
def real_receipt_payloads(tmp_path):
    if not shutil.which("mksquashfs") or not shutil.which("unsquashfs"):
        pytest.skip("SquashFS tools required for actual receipt payload verification")
    args, *_ = fixture(tmp_path)
    root = tmp_path / "tree"
    receipt_dir = root / "etc/tunaos"
    receipt_dir.mkdir(parents=True)
    (receipt_dir / "live-source.json").write_text(json.dumps(args["source_receipt"]), encoding="utf-8")
    (receipt_dir / "live-installer-info").write_text(
        "INSTALLER_BUNDLE_SHA256=" + args["installer_digest"].removeprefix("sha256:") + "\n",
        encoding="utf-8",
    )
    good = tmp_path / "good.squashfs"
    subprocess.run(["mksquashfs", str(root), str(good), "-noappend", "-processors", "1", "-no-progress"],
                   check=True, capture_output=True)
    extra_root = tmp_path / "extra-tree"
    extra_root.mkdir()
    (extra_root / "unrelated").write_text("no receipts here\n", encoding="utf-8")
    extra = tmp_path / "extra.squashfs"
    subprocess.run(["mksquashfs", str(extra_root), str(extra), "-noappend", "-processors", "1", "-no-progress"],
                   check=True, capture_output=True)
    extractor = tmp_path / "extractor.py"
    extractor.write_text(
        "from pathlib import Path\nimport shutil, sys\n"
        "out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)\n"
        f"for source in {list(map(str, (good, extra)))!r}:\n"
        "    target = out / Path(source).name; shutil.copyfile(source, target); print(target)\n",
        encoding="utf-8",
    )
    return args, good, extra, extractor


def test_real_payload_with_confirmed_absent_receipts_does_not_override_valid_identity(tmp_path, real_receipt_payloads):
    args, _good, _extra, extractor = real_receipt_payloads
    diagnostics = {}
    source, installer = helper.extract_media_receipts(args["iso"], extractor, tmp_path / "out", diagnostics)
    assert source == args["source_receipt"]
    assert installer == args["installer_digest"]
    assert all(probe["status"] == "absent" for probe in diagnostics["payloads"][1]["members"].values())


@pytest.mark.parametrize("failure", ["format", "listing", "member-read"])
def test_real_valid_payload_cannot_hide_unreadable_payload(tmp_path, monkeypatch, real_receipt_payloads, failure):
    args, good, extra, extractor = real_receipt_payloads
    if failure == "format":
        extra.write_bytes(b"not a SquashFS filesystem")
    elif failure == "listing":
        extra.write_bytes(good.read_bytes()[:128])
    else:
        extra.write_bytes(good.read_bytes())
        real_probe = helper.run_squashfs_probe

        def unreadable_member(arguments):
            if arguments[0] == "-cat" and Path(arguments[1]).name == extra.name:
                result = subprocess.CompletedProcess(arguments, 2, "", "read failure")
                return result, {"status": "error", "exitCode": 2, "stderr": "read failure"}
            return real_probe(arguments)

        monkeypatch.setattr(helper, "run_squashfs_probe", unreadable_member)
    diagnostics = {}
    with pytest.raises(helper.InputError, match="unreadable filesystem or receipt payloads"):
        helper.extract_media_receipts(args["iso"], extractor, tmp_path / "out", diagnostics)
    assert diagnostics["payloads"][0]["members"]["etc/tunaos/live-source.json"]["status"] == "present"
    second = diagnostics["payloads"][1]
    if failure == "format":
        assert second["filesystem"]["status"] == "error"
    else:
        assert second["members"]["etc/tunaos/live-source.json"]["status"] == "error"
