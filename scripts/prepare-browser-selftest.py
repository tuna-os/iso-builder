#!/usr/bin/env python3
"""Derive strict guest-test inputs only from a round-tripped browser ISO and receipts.

This labels the run diagnostic-unqualified. It does not authenticate the browser
producer or qualify a target; missing media identities fail closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import struct
import sys
import tempfile

SHA40 = re.compile(r"^[0-9a-f]{40}$")
PLATFORM = re.compile(r"^linux/(amd64(?:/v2)?|arm64)$")
BROWSER = re.compile(r"^(HeadlessChrome|Chrome)/([1-9][0-9]*(?:\.[0-9]+)+)$")
GIB = 1024 ** 3


class InputError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise InputError(message)


def require_digest(value, label: str) -> str:
    require(isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-fA-F]{64}", value) is not None,
            f"{label} is missing or is not sha256:<64 hex>")
    return value.lower()


def json_file(path: str | Path, label: str) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputError(f"cannot read {label}: {exc}") from exc
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def parse_source_receipt(value: dict) -> dict:
    fields = ("base_image", "base_digest", "overlay_digest", "engine_digest", "platform")
    require(all(isinstance(value.get(key), str) and value[key] == value[key].strip()
                and value[key] and value[key].lower() != "unknown"
                and not any(ord(c) < 32 or ord(c) == 127 or c.isspace() for c in value[key])
                for key in fields), "live-source.json has missing or invalid identity fields")
    source = require_digest(value["base_digest"], "live-source base_digest")
    overlay = require_digest(value["overlay_digest"], "live-source overlay_digest")
    engine = require_digest(value["engine_digest"], "live-source engine_digest")
    # Existing media receipts treat base_image (a reference) and base_digest
    # (the immutable identity) as separate fields; preserve that contract.
    require(PLATFORM.fullmatch(value["platform"]) is not None,
            "live-source platform is unsupported")
    return {"sourceRef": value["base_image"], "source": source, "overlay": overlay,
            "engine": engine, "platform": value["platform"]}


def parse_installer_receipt(text: str) -> str:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep and key in {"INSTALLER_BUNDLE_SHA256", "INSTALLER_REVISION"}:
            require(key not in fields, f"installer receipt repeats {key}")
            fields[key] = value
    bundle = fields.get("INSTALLER_BUNDLE_SHA256", "")
    revision = fields.get("INSTALLER_REVISION", "")
    candidate = (bundle if re.fullmatch(r"[0-9a-fA-F]{64}", bundle)
                 else revision if re.fullmatch(r"[0-9a-fA-F]{64}", revision) else "")
    require(candidate, "ISO lacks a valid live-installer-info bundle hash or deployed commit")
    return "sha256:" + candidate.lower()


EROFS_MAGIC = 0xE0F5E1E2
RECEIPT_LIMIT = 1024 * 1024


def is_erofs(payload: str | Path) -> bool:
    with open(payload, "rb") as stream:
        stream.seek(1024)
        head = stream.read(4)
    return len(head) == 4 and struct.unpack("<I", head)[0] == EROFS_MAGIC


def erofs_cat(payload: str | Path, member: str) -> bytes | None:
    """Return one regular file from an uncompressed EROFS image, or None if absent.

    The browser engine (tacklebox purefs.WriteErofs) writes its live root as
    EROFS, which unsquashfs cannot read and erofs-utils 1.7 cannot cat. Only
    the plain/inline layouts that writer emits are accepted; anything else
    fails closed rather than being guessed at.
    """
    with open(payload, "rb") as stream:
        size = os.fstat(stream.fileno()).st_size

        def read(offset: int, length: int) -> bytes:
            require(0 <= offset and length >= 0 and offset + length <= size,
                    "EROFS payload reference is out of bounds")
            stream.seek(offset)
            return stream.read(length)

        sb = read(1024, 128)
        require(struct.unpack_from("<I", sb, 0)[0] == EROFS_MAGIC, "payload is not EROFS")
        blkszbits, root_nid = sb[12], struct.unpack_from("<H", sb, 14)[0]
        require(9 <= blkszbits <= 16, "EROFS block size is unsupported")
        block = 1 << blkszbits
        meta = struct.unpack_from("<I", sb, 40)[0] * block

        def inode(nid: int) -> tuple[int, int, bytes]:
            base = meta + nid * 32
            fmt = struct.unpack_from("<H", read(base, 2))[0]
            extended, layout = fmt & 1, (fmt >> 1) & 7
            raw = read(base, 64 if extended else 32)
            xattr_count, mode = struct.unpack_from("<HH", raw, 2)
            length = struct.unpack_from("<Q" if extended else "<I", raw, 8)[0]
            blkaddr = struct.unpack_from("<I", raw, 16)[0]
            require(length <= size, "EROFS inode size is out of bounds")
            xattrs = 12 + (xattr_count - 1) * 4 if xattr_count else 0
            if layout == 0:  # FLAT_PLAIN
                return mode, length, read(blkaddr * block, length)
            require(layout == 2, "EROFS payload uses an unsupported data layout")
            full = length - length % block  # FLAT_INLINE: whole blocks, then inline tail
            tail = read(base + len(raw) + xattrs, length - full)
            return mode, length, (read(blkaddr * block, full) if full else b"") + tail

        nid = root_nid
        parts = member.strip("/").split("/")
        for index, name in enumerate(parts):
            mode, _, data = inode(nid)
            require(mode & 0o170000 == 0o040000, "EROFS receipt path crosses a non-directory")
            found = None
            for start in range(0, len(data), block):
                chunk = data[start:start + block]
                count = struct.unpack_from("<H", chunk, 8)[0] // 12
                require(count > 0 and count * 12 <= len(chunk), "EROFS directory block is malformed")
                for entry in range(count):
                    child, nameoff = struct.unpack_from("<QH", chunk, entry * 12)
                    end = (struct.unpack_from("<H", chunk, (entry + 1) * 12 + 8)[0]
                           if entry + 1 < count else len(chunk))
                    require(nameoff <= end <= len(chunk), "EROFS directory entry is malformed")
                    if chunk[nameoff:end].split(b"\0", 1)[0] == name.encode():
                        found = child
                        break
                if found is not None:
                    break
            if found is None:
                return None
            nid = found
        mode, length, data = inode(nid)
        require(mode & 0o170000 == 0o100000, f"EROFS {member} is not a regular file")
        require(length <= RECEIPT_LIMIT, f"EROFS {member} is too large")
        return data


def cat_payload_member(payload: str | Path, member: str) -> str | None:
    if is_erofs(payload):
        data = erofs_cat(payload, member)
        if data is None:
            return None
        try:
            return data.decode()
        except UnicodeDecodeError as exc:
            raise InputError(f"embedded {member} is not UTF-8") from exc
    result = subprocess.run(["unsquashfs", "-cat", str(payload), member],
                            capture_output=True, text=True)
    return result.stdout if result.returncode == 0 and result.stdout else None


def extract_media_receipts(iso: str | Path, extractor: str | Path, destination: str | Path) -> tuple[dict, str]:
    result = subprocess.run([sys.executable, str(extractor), str(iso), str(destination)],
                            check=True, capture_output=True, text=True)
    root = Path(destination).resolve()
    payloads = []
    for line in result.stdout.splitlines():
        raw_path = Path(line)
        require(raw_path.parent.resolve() == root and not raw_path.is_symlink(),
                "ISO extractor returned a payload outside its private directory")
        path = raw_path.resolve()
        require(path.parent == root and path.is_file(), "ISO extractor returned a non-regular payload")
        payloads.append(path)
    require(payloads, "ISO contains no live filesystem payloads")

    sources, installers = [], []
    for payload in payloads:
        for member, destination_list in (("etc/tunaos/live-source.json", sources),
                                         ("etc/tunaos/live-installer-info", installers)):
            text = cat_payload_member(payload, member)
            if text:
                destination_list.append(text)
    require(sources, "ISO has no embedded etc/tunaos/live-source.json receipt")
    raw_sources, sources_normalized = [], []
    for text in sources:
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InputError(f"embedded live-source.json is invalid JSON: {exc}") from exc
        require(isinstance(value, dict), "embedded live-source.json must be an object")
        raw_sources.append(value)
        sources_normalized.append(parse_source_receipt(value))
    require(all(item == sources_normalized[0] for item in sources_normalized[1:]),
            "ISO payloads disagree on live-source identity")
    require(installers, "ISO has no embedded etc/tunaos/live-installer-info receipt")
    installer_digests = [parse_installer_receipt(text) for text in installers]
    require(all(item == installer_digests[0] for item in installer_digests[1:]),
            "ISO payloads disagree on installer identity")
    return raw_sources[0], installer_digests[0]


def validate_inputs(*, iso: str | Path, measurements: dict, browser_evidence: dict,
                    artifact_manifest: dict, source_receipt: dict, installer_digest: str,
                    repository: str, run_id: str, run_attempt: str, source_sha: str,
                    artifact_id: str, artifact_name: str, variant: str, flavor: str,
                    slug: str, platform: str, measurement_repository: str | None = None,
                    measurement_run_id: str | None = None,
                    measurement_run_attempt: str | None = None) -> tuple[dict, dict]:
    require(repository == "tuna-os/iso-builder", "producer repository is not tuna-os/iso-builder")
    require(run_id.isdigit() and int(run_id) > 0, "producer run id is invalid")
    require(run_attempt.isdigit() and int(run_attempt) > 0, "producer run attempt is invalid")
    require(SHA40.fullmatch(source_sha) is not None, "producer source SHA is invalid")
    require(artifact_id.isdigit() and int(artifact_id) > 0, "uploaded artifact id is invalid")
    require(slug == f"{variant}-{flavor}", "target slug does not match variant and flavor")
    require(artifact_name == f"iso-{slug}-run{run_id}-a{run_attempt}",
            "artifact name does not bind target, run id and attempt")
    require(PLATFORM.fullmatch(platform) is not None, "matrix platform is unsupported")
    image = f"tuna-os/{variant}:{flavor}"

    require(measurements.get("schemaVersion") == 1 and
            measurements.get("kind") == "diagnostic-build-measurements",
            "browser measurements are not diagnostic-build-measurements v1")
    require(measurements.get("qualification") == "diagnostic-unqualified",
            "self-test accepts only diagnostic-unqualified browser builds")
    diagnostic = measurements.get("diagnosticUnqualified")
    require(isinstance(diagnostic, dict) and diagnostic.get("label") == "diagnostic, unqualified build",
            "browser measurements lack the diagnostic-unqualified label")
    require(diagnostic.get("image") == image and diagnostic.get("platform") == platform,
            "browser measurement target differs from the requested matrix cell")

    measured_iso = measurements.get("iso") or {}
    expected_iso = require_digest(measured_iso.get("sha256"), "browser ISO measurement")
    require(isinstance(measured_iso.get("sizeBytes"), int) and
            not isinstance(measured_iso.get("sizeBytes"), bool) and measured_iso["sizeBytes"] > 0,
            "browser ISO size is invalid")
    hasher, size = hashlib.sha256(), 0
    with open(iso, "rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            hasher.update(block)
            size += len(block)
    actual_iso = "sha256:" + hasher.hexdigest()
    require(actual_iso == expected_iso and size == measured_iso["sizeBytes"],
            "round-tripped ISO differs from browser-measured bytes")

    manifest = artifact_manifest
    require(manifest.get("kind") == "candidate-iso-artifact-manifest" and
            manifest.get("schemaVersion") == 1, "artifact manifest schema is invalid")
    require(manifest.get("qualification") == "diagnostic-unqualified",
            "artifact manifest is not diagnostic-unqualified")
    require(manifest.get("slug") == slug, "artifact manifest target differs from the selected target")
    require(manifest.get("iso") == {"sha256": actual_iso, "sizeBytes": size},
            "artifact manifest does not bind the round-tripped ISO")
    producer = manifest.get("producer") or {}
    expected_producer = {"repository": repository, "runId": run_id,
                         "runAttempt": run_attempt, "sha": source_sha}
    require(all(producer.get(key) == value for key, value in expected_producer.items()),
            "artifact manifest producer differs from this run, attempt, repository or source SHA")
    expected_measurements = {key: measurements[key] for key in
                             ("iso", "loadedWasm", "browser", "phasesMs", "diagnosticUnqualified")
                             if key in measurements}
    require(manifest.get("measurements") == expected_measurements,
            "artifact manifest measurements differ from the browser evidence")

    loaded_wasm = measurements.get("loadedWasm") or {}
    loaded_wasm_digest = require_digest(loaded_wasm.get("sha256"), "loaded WASM measurement")
    require(isinstance(loaded_wasm.get("sizeBytes"), int) and
            not isinstance(loaded_wasm.get("sizeBytes"), bool) and loaded_wasm["sizeBytes"] > 0,
            "loaded WASM size is invalid")
    build = measurements.get("engineBuildResult")
    require(isinstance(build, dict), "browser measurements lack engineBuildResult")
    require(build.get("bytesWritten") == size, "engineBuildResult byte count differs from the ISO")
    observed = build.get("observedInputs") or {}
    measured_source = require_digest((observed.get("source") or {}).get("manifestDigest"),
                                     "observed source manifest")
    overlay_result = observed.get("overlay") or {}
    require(overlay_result.get("status") == "applied" and overlay_result.get("layersApplied") is True,
            "browser engine did not observe an applied live overlay")
    measured_overlay = require_digest(overlay_result.get("manifestDigest"), "observed overlay manifest")
    require(isinstance(overlay_result.get("baseAnnotationMatched"), bool),
            "browser engine did not report the overlay base-annotation comparison")
    source = parse_source_receipt(source_receipt)
    require(source["platform"] == platform, "media platform differs from the matrix target")
    require(measured_source == source["source"],
            "media source digest differs from the browser engine observation")
    require(measured_overlay == source["overlay"],
            "media overlay digest differs from the browser engine observation")
    # RFC 014: a browser build's engine is the WASM module the page loaded;
    # the receipt must name those bytes, not a native tacklebox or a label.
    require(source["engine"] == loaded_wasm_digest,
            "media engine digest differs from the loaded WASM measurement")
    require_digest(installer_digest, "ISO installer receipt")

    browser = measurements.get("browser") or {}
    browser_match = BROWSER.fullmatch(browser.get("product") or "")
    require(browser_match is not None and isinstance(browser.get("userAgent"), str)
            and browser["userAgent"].strip(),
            "browser measurements lack a same-session Chromium product, version or user agent")
    evidence_diag = browser_evidence.get("diagnosticUnqualified") or {}
    evidence_target = browser_evidence.get("target") or {}
    evidence_browser = browser_evidence.get("browser") or {}
    evidence_run = browser_evidence.get("run") or {}
    require(browser_evidence.get("kind") == "qualification-evidence" and
            browser_evidence.get("half") == "browser" and
            browser_evidence.get("qualification") == "diagnostic-unqualified",
            "browser evidence is not a diagnostic-unqualified browser half")
    require(evidence_target.get("image") == image and evidence_target.get("platform") == platform and
            evidence_diag.get("image") == image and evidence_diag.get("platform") == platform,
            "browser evidence target differs from the media and matrix")
    require(evidence_browser.get("userAgent") == browser["userAgent"] and evidence_run.get("sample") == 1,
            "browser evidence user agent or sample differs from the measured build")

    cpu_baseline = {"linux/amd64": "x86-64", "linux/amd64/v2": "x86-64-v2",
                    "linux/arm64": "armv8-a"}[platform]
    memory_bytes = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    memory_gib = memory_bytes // GIB
    free_disk_gib = shutil.disk_usage(Path(iso).parent).free // GIB
    require(memory_gib > 0 and free_disk_gib > 0, "browser-host memory/disk profile is unavailable")
    env = {
        "VARIANT": variant,
        "FLAVOR": flavor,
        "TUNAOS_QUAL_SOURCE_DIGEST": source["source"],
        "TUNAOS_QUAL_SOURCE_REF": source["sourceRef"],
        "TUNAOS_QUAL_OVERLAY_DIGEST": source["overlay"],
        "TUNAOS_QUAL_INSTALLER_DIGEST": installer_digest,
        "TUNAOS_QUAL_ENGINE_DIGEST": source["engine"],
        "TUNAOS_QUAL_MEDIA_DIGEST": actual_iso,
        "TUNAOS_QUAL_PLATFORM": platform,
        "TUNAOS_QUAL_CPU_BASELINE": cpu_baseline,
        "TUNAOS_QUAL_HARDWARE_SCOPE": "qemu",
        "TUNAOS_QUAL_EXECUTION_KIND": "browser",
        "STRICT_PUBLISHED_MEDIA": "0",
        "TUNAOS_QUAL_BROWSER_NAME": browser_match.group(1),
        "TUNAOS_QUAL_BROWSER_VERSION": browser_match.group(2),
        "TUNAOS_QUAL_BROWSER_MEMORY_GIB": str(memory_gib),
        "TUNAOS_QUAL_BROWSER_FREE_DISK_GIB": str(free_disk_gib),
    }
    for key, value in env.items():
        require(isinstance(value, str) and "\n" not in value and "\r" not in value,
                f"unsafe environment value for {key}")
    binding = {
        "schema": "BrowserIsoSameByteGuestTest/v1",
        "qualification": "diagnostic-unqualified",
        "notice": "This test does not authenticate the producer or qualify the target.",
        "producer": {**expected_producer, "artifactName": artifact_name, "artifactId": int(artifact_id)},
        "target": {"image": image, "slug": slug, "platform": platform, "cpuBaseline": cpu_baseline},
        "iso": {"sha256": actual_iso, "sizeBytes": size},
        "measurements": {"loadedWasm": loaded_wasm, "browser": browser,
                         "engineBuildResult": build},
        "identities": {"source": source["source"], "sourceRef": source["sourceRef"],
                       "overlay": source["overlay"],
                       "overlayBaseAnnotationMatched": overlay_result.get("baseAnnotationMatched"),
                       "installer": installer_digest, "engine": source["engine"]},
        "hostProfile": {"memoryGiB": memory_gib, "freeDiskGiB": free_disk_gib,
                        "measuredOnBrowserRunner": (
                            measurement_repository == repository and measurement_run_id == run_id
                            and measurement_run_attempt == run_attempt),
                        "measurementOrigin": (
                            "producer-run" if measurement_repository == repository
                            and measurement_run_id == run_id and measurement_run_attempt == run_attempt
                            else "recovery-host")},
        "missingBrowserIdentity": measurements.get("missingIdentity", []),
    }
    return env, binding


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iso", required=True)
    parser.add_argument("--measurements", required=True)
    parser.add_argument("--browser-evidence", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--payload-extractor", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--flavor", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--out-env", required=True)
    parser.add_argument("--out-binding", required=True)
    args = parser.parse_args(argv)
    try:
        with tempfile.TemporaryDirectory(prefix="browser-iso-receipts-") as payload_dir:
            source, installer = extract_media_receipts(args.iso, args.payload_extractor, payload_dir)
        env, binding = validate_inputs(
            iso=args.iso, measurements=json_file(args.measurements, "browser measurements"),
            browser_evidence=json_file(args.browser_evidence, "browser evidence"),
            artifact_manifest=json_file(args.manifest, "artifact manifest"),
            source_receipt=source, installer_digest=installer, repository=args.repository,
            run_id=args.run_id, run_attempt=args.run_attempt, source_sha=args.source_sha,
            artifact_id=args.artifact_id, artifact_name=args.artifact_name,
            variant=args.variant, flavor=args.flavor, slug=args.slug, platform=args.platform,
            measurement_repository=os.environ.get("GITHUB_REPOSITORY"),
            measurement_run_id=os.environ.get("GITHUB_RUN_ID"),
            measurement_run_attempt=os.environ.get("GITHUB_RUN_ATTEMPT"),
        )
    except (InputError, OSError, subprocess.CalledProcessError) as exc:
        print(f"same-byte guest input validation failed: {exc}", file=sys.stderr)
        return 1
    env_path = Path(args.out_env)
    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("".join(f"{key}={value}\n" for key, value in env.items()), encoding="utf-8")
    Path(args.out_binding).write_text(json.dumps(binding, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"validated diagnostic same-byte guest inputs for {args.slug} {binding['iso']['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
