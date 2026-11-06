#!/usr/bin/env python3
"""Build a BrowserIsoQualificationReceipt/v1 from a passed both-mode strict run.

Inputs: the strict harness output directory (strict-qual-plain.json and
strict-qual-luks.json, copied verbatim into the receipt), the same-byte guest
test binding written by prepare-browser-selftest.py (ISO bytes, producer run
and artifact, media identities, target), the strict harness revision pinned in
.github/workflows/ci.yml (the one source of truth for it), and this run's
GITHUB_* identity.

Writes canonical receipt.json: json.dumps(sort_keys=True, separators=(",", ":"))
with no trailing newline, so its sha256 is the receipt digest. The receipt only
becomes authenticated once the workflow attests it with
actions/attest-build-provenance; this script never signs anything.

Refuses (exit 1, reason on stderr) unless the run was non-diagnostic, ran
STRICT_INSTALL_MODE=both, is on refs/heads/main, and every validity rule of the
contract holds. Nothing here relaxes a harness result: a failed or missing leg
means no receipt.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SCHEMA = "BrowserIsoQualificationReceipt/v1"
QUALIFICATION = "browser-qualified"
PRODUCER_REPOSITORY = "tuna-os/iso-builder"
WORKFLOW_PATH = ".github/workflows/ci.yml"
MAIN_REF = "refs/heads/main"
HARNESS_REPOSITORY = "tuna-os/tunaOS"
HARNESS_CHECKOUT_PATH = "tunaos-e2e-current"
PLATFORM = "linux/amd64"
MODES = ("plain", "luks")
REQUIRED = ("installed_boot", "desktop_contract", "cold_boot", "warm_boot", "media_detached",
            "boot_arguments_unmodified", "gui_account_created", "gui_login")
DURATIONS = ("duration_s", "install_duration_s", "cold_boot_s", "warm_boot_s")
PASSPHRASE_PROMPT = {"plain": False, "luks": True}

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TUNAOS_IMAGE = re.compile(r"^tuna-os/([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:[.-][a-z0-9]+)*)$")


class ReceiptError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReceiptError(message)


def positive_int(value, label: str) -> int:
    require(type(value) is int and value > 0, f"{label} must be a positive integer")
    return value


def positive_decimal(value, label: str) -> int:
    require(isinstance(value, str) and value.isdigit() and int(value) > 0 and str(int(value)) == value,
            f"{label} must be a positive decimal integer")
    return int(value)


def digest(value, label: str) -> str:
    require(isinstance(value, str) and DIGEST.fullmatch(value) is not None,
            f"{label} must be lowercase sha256:<64 hex>")
    return value


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def json_object(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReceiptError(f"cannot read {label} {path}: {exc}") from exc
    require(isinstance(value, dict), f"{label} {path} must be a JSON object")
    return value


def pinned_harness_revision(workflow_text: str) -> str:
    """The tuna-os/tunaOS ref of the checkout step whose path is the strict harness."""
    lines = workflow_text.splitlines()
    hits = [i for i, line in enumerate(lines)
            if re.fullmatch(rf"\s*path:\s*{re.escape(HARNESS_CHECKOUT_PATH)}\s*", line)]
    require(len(hits) == 1, f"ci.yml must have exactly one checkout with path: {HARNESS_CHECKOUT_PATH}")
    start = hits[0]
    while start > 0 and not re.match(r"\s*- ", lines[start]):
        start -= 1
    block = lines[start:hits[0] + 1]
    repos = [m.group(1) for line in block if (m := re.fullmatch(r"\s*repository:\s*(\S+)\s*", line))]
    refs = [m.group(1) for line in block if (m := re.fullmatch(r"\s*ref:\s*(\S+)\s*", line))]
    require(repos == [HARNESS_REPOSITORY], f"the {HARNESS_CHECKOUT_PATH} checkout is not {HARNESS_REPOSITORY}")
    require(len(refs) == 1 and SHA40.fullmatch(refs[0]) is not None,
            f"the {HARNESS_CHECKOUT_PATH} checkout ref is not a pinned 40-hex commit")
    return refs[0]


def checkout_revision(checkout: Path) -> str:
    try:
        result = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"],
                                capture_output=True, text=True, check=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReceiptError(f"cannot read the harness checkout revision in {checkout}: {exc}") from exc
    return result.stdout.strip()


def validate_mode(mode: str, frag, image: str, image_digest: str) -> None:
    require(isinstance(frag, dict), f"modes.{mode} must be a JSON object")
    require(frag.get("mode") == mode, f"modes.{mode}.mode is {frag.get('mode')!r}, not {mode!r}")
    for key in REQUIRED:
        require(frag.get(key) is True, f"modes.{mode}.{key} is {frag.get(key)!r}, not true")
    require(frag.get("passphrase_prompt") is PASSPHRASE_PROMPT[mode],
            f"modes.{mode}.passphrase_prompt must be {str(PASSPHRASE_PROMPT[mode]).lower()}")
    digest(frag.get("source_digest"), f"modes.{mode}.source_digest")
    digest(frag.get("booted_digest"), f"modes.{mode}.booted_digest")
    require(frag["booted_digest"] == frag["source_digest"] == image_digest,
            f"modes.{mode} booted_digest/source_digest differ from target.imageDigest {image_digest}")
    require(frag.get("target_imgref") == image,
            f"modes.{mode}.target_imgref {frag.get('target_imgref')!r} is not target.image {image!r}")
    for key in ("cold_boot_id", "warm_boot_id"):
        require(isinstance(frag.get(key), str) and UUID.fullmatch(frag[key]) is not None,
                f"modes.{mode}.{key} must be a lowercase canonical UUID")
    require(frag["cold_boot_id"] != frag["warm_boot_id"],
            f"modes.{mode} warm boot reported the cold boot's boot_id; no distinct reboot")
    for key in DURATIONS:
        require(type(frag.get(key)) is int and frag[key] >= 0,
                f"modes.{mode}.{key} must be a non-negative integer")


def validate_receipt(receipt: dict) -> None:
    """Every validity rule of BrowserIsoQualificationReceipt/v1 (the consumer enforces the same)."""
    require(set(receipt) == {"schema", "qualification", "qualifiedAt", "target", "iso", "producer",
                             "harness", "inputs", "modes"}, "receipt has missing or extra top-level fields")
    require(receipt["schema"] == SCHEMA and receipt["qualification"] == QUALIFICATION,
            "receipt schema or qualification label is wrong")
    require(isinstance(receipt["qualifiedAt"], str) and TIMESTAMP.fullmatch(receipt["qualifiedAt"]) is not None,
            "qualifiedAt must be YYYY-MM-DDTHH:MM:SSZ")
    target = receipt["target"]
    require(target["platform"] == PLATFORM, f"target.platform must be {PLATFORM}")
    require(NAME.fullmatch(target["variant"]) is not None and
            re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", target["flavor"]) is not None,
            "target variant/flavor are not registry name components")
    require(target["image"] == f"ghcr.io/tuna-os/{target['variant']}:{target['flavor']}",
            "target.image must be ghcr.io/tuna-os/<variant>:<flavor>")
    image_digest = digest(target["imageDigest"], "target.imageDigest")
    iso = receipt["iso"]
    digest(iso["sha256"], "iso.sha256")
    positive_int(iso["sizeBytes"], "iso.sizeBytes")
    producer = receipt["producer"]
    require(producer["repository"] == PRODUCER_REPOSITORY and producer["workflow"] == WORKFLOW_PATH
            and producer["ref"] == MAIN_REF, "producer must be tuna-os/iso-builder ci.yml on refs/heads/main")
    require(SHA40.fullmatch(producer["sha"]) is not None, "producer.sha must be 40 lowercase hex")
    run_id = positive_int(producer["runId"], "producer.runId")
    attempt = positive_int(producer["runAttempt"], "producer.runAttempt")
    slug = f"{target['variant']}-{target['flavor']}"
    require(producer["isoArtifactName"] == f"iso-{slug}-run{run_id}-a{attempt}",
            "producer.isoArtifactName does not bind target, run id and attempt")
    positive_int(producer["isoArtifactId"], "producer.isoArtifactId")
    harness = receipt["harness"]
    require(harness["repository"] == HARNESS_REPOSITORY and SHA40.fullmatch(harness["revision"]) is not None,
            "harness must be tuna-os/tunaOS at a 40-hex revision")
    inputs = receipt["inputs"]
    require(set(inputs) == {"source", "overlay", "installer", "engine"}, "inputs must name source, overlay, installer, engine")
    for key, value in inputs.items():
        digest(value, f"inputs.{key}")
    require(inputs["source"] == image_digest, "inputs.source differs from target.imageDigest")
    modes = receipt["modes"]
    require(isinstance(modes, dict) and set(modes) == set(MODES),
            "both modes (plain and luks) are required; a single-mode run never qualifies")
    for mode in MODES:
        validate_mode(mode, modes[mode], target["image"], image_digest)


def build_receipt(*, harness_output: Path, binding: dict, workflow_text: str, slug: str,
                  install_mode: str, diagnostic_unqualified: str, environ: dict,
                  qualified_at: str, harness_checkout_revision: str | None = None) -> dict:
    require(diagnostic_unqualified == "false",
            "diagnostic_unqualified=true is never a qualification; no receipt for a diagnostic run")
    require(install_mode == "both",
            f"strict_install_mode={install_mode!r}: a receipt needs both plain and LUKS legs (mode both)")
    require(environ.get("GITHUB_REF") == MAIN_REF,
            f"GITHUB_REF={environ.get('GITHUB_REF')!r}: receipts are produced only on {MAIN_REF}")
    require(environ.get("GITHUB_REPOSITORY") == PRODUCER_REPOSITORY,
            f"GITHUB_REPOSITORY is not {PRODUCER_REPOSITORY}")
    require(environ.get("GITHUB_WORKFLOW_REF") == f"{PRODUCER_REPOSITORY}/{WORKFLOW_PATH}@{MAIN_REF}",
            "GITHUB_WORKFLOW_REF is not ci.yml on refs/heads/main")
    sha = environ.get("GITHUB_SHA", "")
    require(SHA40.fullmatch(sha) is not None, "GITHUB_SHA must be 40 lowercase hex")
    run_id = positive_decimal(environ.get("GITHUB_RUN_ID"), "GITHUB_RUN_ID")
    attempt = positive_decimal(environ.get("GITHUB_RUN_ATTEMPT"), "GITHUB_RUN_ATTEMPT")

    harness_revision = pinned_harness_revision(workflow_text)
    if harness_checkout_revision is not None:
        require(harness_checkout_revision == harness_revision,
                f"harness checkout is at {harness_checkout_revision!r}, ci.yml pins {harness_revision}")

    require(binding.get("schema") == "BrowserIsoSameByteGuestTest/v1", "binding schema is not BrowserIsoSameByteGuestTest/v1")
    require(binding.get("qualification") == "not-assessed", "binding is not a non-diagnostic (not-assessed) observation")
    require(binding.get("installMode") == "both", "binding was not prepared for install mode both")
    producer = binding.get("producer") or {}
    require(producer.get("repository") == PRODUCER_REPOSITORY and producer.get("runId") == str(run_id)
            and producer.get("runAttempt") == str(attempt) and producer.get("sha") == sha,
            "binding producer differs from this run's repository, run id, attempt or SHA")
    artifact_name = f"iso-{slug}-run{run_id}-a{attempt}"
    require(producer.get("artifactName") == artifact_name, f"binding artifact is not {artifact_name}")
    artifact_id = positive_int(producer.get("artifactId"), "binding producer.artifactId")
    target = binding.get("target") or {}
    match = TUNAOS_IMAGE.fullmatch(target.get("image") or "")
    require(match is not None, "binding target is not a tuna-os/<variant>:<flavor> image")
    variant, flavor = match.groups()
    require(target.get("slug") == slug == f"{variant}-{flavor}", "binding target slug differs from the matrix cell")
    require(target.get("platform") == PLATFORM, f"binding target platform is not {PLATFORM}")
    iso = binding.get("iso") or {}
    identities = binding.get("identities") or {}

    modes = {}
    for mode in MODES:
        path = Path(harness_output) / f"strict-qual-{mode}.json"
        require(path.is_file(), f"{path} is missing: the {mode} leg did not pass")
        modes[mode] = json_object(path, f"strict {mode} result")

    receipt = {
        "schema": SCHEMA,
        "qualification": QUALIFICATION,
        "qualifiedAt": qualified_at,
        "target": {"variant": variant, "flavor": flavor, "platform": PLATFORM,
                   "image": f"ghcr.io/tuna-os/{variant}:{flavor}",
                   "imageDigest": identities.get("source")},
        "iso": {"sha256": iso.get("sha256"), "sizeBytes": iso.get("sizeBytes")},
        "producer": {"repository": PRODUCER_REPOSITORY, "workflow": WORKFLOW_PATH, "ref": MAIN_REF,
                     "sha": sha, "runId": run_id, "runAttempt": attempt,
                     "isoArtifactName": artifact_name, "isoArtifactId": artifact_id},
        "harness": {"repository": HARNESS_REPOSITORY, "revision": harness_revision},
        "inputs": {key: identities.get(key) for key in ("source", "overlay", "installer", "engine")},
        "modes": modes,
    }
    validate_receipt(receipt)
    return receipt


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--harness-output", required=True, help="strict harness --output directory")
    parser.add_argument("--binding", required=True, help="same-byte-guest-test-binding-<slug>.json")
    parser.add_argument("--workflow", default=WORKFLOW_PATH, help="ci.yml carrying the pinned harness ref")
    parser.add_argument("--harness-checkout", help="checked-out harness; its HEAD must equal the pin")
    parser.add_argument("--slug", required=True)
    parser.add_argument("--install-mode", required=True)
    parser.add_argument("--diagnostic-unqualified", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        try:
            workflow_text = Path(args.workflow).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ReceiptError(f"cannot read {args.workflow}: {exc}") from exc
        receipt = build_receipt(
            harness_output=Path(args.harness_output),
            binding=json_object(Path(args.binding), "same-byte binding"),
            workflow_text=workflow_text, slug=args.slug, install_mode=args.install_mode,
            diagnostic_unqualified=args.diagnostic_unqualified, environ=dict(os.environ),
            qualified_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            harness_checkout_revision=(checkout_revision(Path(args.harness_checkout))
                                       if args.harness_checkout else None),
        )
    except (ReceiptError, KeyError, TypeError) as exc:
        print(f"qualification receipt refused: {exc}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(canonical(receipt))
    print(f"qualification receipt for {receipt['target']['image']}@{receipt['target']['imageDigest']} "
          f"ISO {receipt['iso']['sha256']} written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
