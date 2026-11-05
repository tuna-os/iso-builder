"""scripts/build-qualification-receipt.py: BrowserIsoQualificationReceipt/v1.

A receipt exists only for one ISO whose plain AND LUKS strict legs both passed
on refs/heads/main, non-diagnostic, with every contract validity rule holding.
"""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts/build-qualification-receipt.py"
CI_YML = ROOT / ".github/workflows/ci.yml"
spec = importlib.util.spec_from_file_location("qualification_receipt", SCRIPT)
receipt_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt_mod)

needs_just = pytest.mark.skipif(shutil.which("just") is None, reason="just not installed")


def digest(text):
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


SOURCE = digest("source")
SHA = "c" * 40
RUN_ID = "4242"
ATTEMPT = "2"
SLUG = "bonito-kde"
IMAGE = "ghcr.io/tuna-os/bonito:kde"
NOW = "2026-11-05T12:00:00Z"


def fragment(mode):
    ids = {"plain": ("0b3c4a1e-1111-4a6e-9a51-0123456789ab", "0b3c4a1e-2222-4a6e-9a51-0123456789ab"),
           "luks": ("0b3c4a1e-3333-4a6e-9a51-0123456789ab", "0b3c4a1e-4444-4a6e-9a51-0123456789ab")}[mode]
    return {"mode": mode, "installed_boot": True, "desktop_contract": True, "cold_boot": True,
            "warm_boot": True, "media_detached": True, "boot_arguments_unmodified": True,
            "passphrase_prompt": mode == "luks", "source_digest": SOURCE, "booted_digest": SOURCE,
            "target_imgref": IMAGE, "duration_s": 900, "install_duration_s": 300,
            "cold_boot_s": 40, "warm_boot_s": 30, "cold_boot_id": ids[0], "warm_boot_id": ids[1],
            "gui_account_created": True, "gui_login": True}


def binding():
    return {
        "schema": "BrowserIsoSameByteGuestTest/v1", "qualification": "not-assessed", "installMode": "both",
        "producer": {"repository": "tuna-os/iso-builder", "runId": RUN_ID, "runAttempt": ATTEMPT, "sha": SHA,
                     "artifactName": f"iso-{SLUG}-run{RUN_ID}-a{ATTEMPT}", "artifactId": 777},
        "target": {"image": "tuna-os/bonito:kde", "slug": SLUG, "platform": "linux/amd64", "cpuBaseline": "x86-64"},
        "iso": {"sha256": digest("iso"), "sizeBytes": 5_000_000_000},
        "identities": {"source": SOURCE, "sourceRef": "ghcr.io/tuna-os/bonito:kde", "overlay": digest("overlay"),
                       "overlayBaseAnnotationMatched": True, "installer": digest("installer"),
                       "engine": digest("engine")},
    }


def environ(**over):
    env = {"GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": "tuna-os/iso-builder",
           "GITHUB_WORKFLOW_REF": "tuna-os/iso-builder/.github/workflows/ci.yml@refs/heads/main",
           "GITHUB_SHA": SHA, "GITHUB_RUN_ID": RUN_ID, "GITHUB_RUN_ATTEMPT": ATTEMPT}
    env.update(over)
    return env


def harness_dir(tmp_path, plain=None, luks=None, skip=()):
    out = tmp_path / f"luks-verify-{SLUG}-obs"
    out.mkdir(exist_ok=True)
    for mode, frag in (("plain", plain or fragment("plain")), ("luks", luks or fragment("luks"))):
        if mode not in skip:
            (out / f"strict-qual-{mode}.json").write_text(json.dumps(frag, indent=2))
    return out


def build(tmp_path, *, plain=None, luks=None, skip=(), bind=None, env=None, mode="both", diagnostic="false"):
    return receipt_mod.build_receipt(
        harness_output=harness_dir(tmp_path, plain, luks, skip), binding=bind or binding(),
        workflow_text=CI_YML.read_text(), slug=SLUG, install_mode=mode, diagnostic_unqualified=diagnostic,
        environ=env or environ(), qualified_at=NOW)


def pinned():
    wf = yaml.safe_load(CI_YML.read_text())
    step = next(s for s in wf["jobs"]["full-matrix"]["steps"]
                if s.get("with", {}).get("path") == "tunaos-e2e-current")
    return step["with"]["ref"]


def test_builds_the_contract_receipt_from_both_legs(tmp_path):
    receipt = build(tmp_path)
    assert receipt == {
        "schema": "BrowserIsoQualificationReceipt/v1",
        "qualification": "browser-qualified",
        "qualifiedAt": NOW,
        "target": {"variant": "bonito", "flavor": "kde", "platform": "linux/amd64", "image": IMAGE,
                   "imageDigest": SOURCE},
        "iso": {"sha256": digest("iso"), "sizeBytes": 5_000_000_000},
        "producer": {"repository": "tuna-os/iso-builder", "workflow": ".github/workflows/ci.yml",
                     "ref": "refs/heads/main", "sha": SHA, "runId": 4242, "runAttempt": 2,
                     "isoArtifactName": f"iso-{SLUG}-run4242-a2", "isoArtifactId": 777},
        "harness": {"repository": "tuna-os/tunaOS", "revision": pinned()},
        "inputs": {"source": SOURCE, "overlay": digest("overlay"), "installer": digest("installer"),
                   "engine": digest("engine")},
        "modes": {"plain": fragment("plain"), "luks": fragment("luks")},
    }


def test_harness_revision_is_the_ci_yml_strict_pin():
    assert receipt_mod.pinned_harness_revision(CI_YML.read_text()) == pinned()
    assert re.fullmatch(r"[0-9a-f]{40}", pinned())


def test_harness_checkout_must_match_the_pin(tmp_path):
    with pytest.raises(receipt_mod.ReceiptError, match="harness checkout"):
        receipt_mod.build_receipt(
            harness_output=harness_dir(tmp_path), binding=binding(), workflow_text=CI_YML.read_text(),
            slug=SLUG, install_mode="both", diagnostic_unqualified="false", environ=environ(),
            qualified_at=NOW, harness_checkout_revision="d" * 40)


@pytest.mark.parametrize("mode", ["plain", "luks"])
def test_refuses_when_one_mode_is_missing(tmp_path, mode):
    with pytest.raises(receipt_mod.ReceiptError, match=f"{mode} leg did not pass"):
        build(tmp_path, skip=(mode,))


@pytest.mark.parametrize("mode", ["plain", "luks"])
@pytest.mark.parametrize("key", receipt_mod.REQUIRED)
@pytest.mark.parametrize("value", [False, None, "true", 1])
def test_refuses_any_required_check_that_is_not_true(tmp_path, mode, key, value):
    frag = fragment(mode)
    if value is None:
        del frag[key]
    else:
        frag[key] = value
    with pytest.raises(receipt_mod.ReceiptError, match=key):
        build(tmp_path, **{mode: frag})


@pytest.mark.parametrize("mode,value", [("plain", True), ("luks", False), ("plain", None), ("luks", "yes")])
def test_refuses_wrong_passphrase_prompt_for_the_mode(tmp_path, mode, value):
    frag = fragment(mode)
    frag["passphrase_prompt"] = value
    with pytest.raises(receipt_mod.ReceiptError, match="passphrase_prompt"):
        build(tmp_path, **{mode: frag})


@pytest.mark.parametrize("mode", ["plain", "luks"])
@pytest.mark.parametrize("key", ["booted_digest", "source_digest"])
def test_refuses_booted_or_source_digest_other_than_the_image(tmp_path, mode, key):
    frag = fragment(mode)
    frag[key] = digest("another image")
    with pytest.raises(receipt_mod.ReceiptError, match="imageDigest"):
        build(tmp_path, **{mode: frag})


def test_refuses_uppercase_digest(tmp_path):
    frag = fragment("plain")
    frag["booted_digest"] = SOURCE.upper().replace("SHA256", "sha256")
    with pytest.raises(receipt_mod.ReceiptError, match="booted_digest"):
        build(tmp_path, plain=frag)


@pytest.mark.parametrize("mode", ["plain", "luks"])
def test_refuses_equal_cold_and_warm_boot_ids(tmp_path, mode):
    frag = fragment(mode)
    frag["warm_boot_id"] = frag["cold_boot_id"]
    with pytest.raises(receipt_mod.ReceiptError, match="distinct reboot"):
        build(tmp_path, **{mode: frag})


@pytest.mark.parametrize("value", ["", "not-a-uuid", "0B3C4A1E-1111-4A6E-9A51-0123456789AB",
                                   "0b3c4a1e11114a6e9a510123456789ab"])
def test_refuses_boot_id_that_is_not_a_canonical_uuid(tmp_path, value):
    frag = fragment("luks")
    frag["cold_boot_id"] = value
    with pytest.raises(receipt_mod.ReceiptError, match="cold_boot_id"):
        build(tmp_path, luks=frag)


@pytest.mark.parametrize("value", ["ghcr.io/tuna-os/bonito:latest", "tuna-os/bonito:kde", None])
def test_refuses_target_imgref_other_than_the_image(tmp_path, value):
    frag = fragment("plain")
    frag["target_imgref"] = value
    with pytest.raises(receipt_mod.ReceiptError, match="target_imgref"):
        build(tmp_path, plain=frag)


def test_refuses_fragment_whose_mode_field_disagrees(tmp_path):
    with pytest.raises(receipt_mod.ReceiptError, match="modes.luks.mode"):
        build(tmp_path, luks=fragment("plain"))


@pytest.mark.parametrize("value", [-1, 1.5, True, "900", None])
def test_refuses_non_integer_durations(tmp_path, value):
    frag = fragment("plain")
    frag["warm_boot_s"] = value
    with pytest.raises(receipt_mod.ReceiptError, match="warm_boot_s"):
        build(tmp_path, plain=frag)


@pytest.mark.parametrize("ref", ["refs/heads/feat/both-mode-qualification-receipt", "refs/pull/1/merge",
                                 "refs/tags/v1", None])
def test_refuses_any_ref_but_main(tmp_path, ref):
    env = environ(GITHUB_REF=ref)
    if ref is None:
        del env["GITHUB_REF"]
    with pytest.raises(receipt_mod.ReceiptError, match="refs/heads/main"):
        build(tmp_path, env=env)


@pytest.mark.parametrize("key,value", [
    ("GITHUB_REPOSITORY", "someone/iso-builder"),
    ("GITHUB_WORKFLOW_REF", "tuna-os/iso-builder/.github/workflows/other.yml@refs/heads/main"),
    ("GITHUB_SHA", "C" * 40), ("GITHUB_RUN_ID", "0"), ("GITHUB_RUN_ATTEMPT", "x"),
])
def test_refuses_foreign_or_malformed_run_identity(tmp_path, key, value):
    with pytest.raises(receipt_mod.ReceiptError):
        build(tmp_path, env=environ(**{key: value}))


def test_refuses_diagnostic_runs(tmp_path):
    with pytest.raises(receipt_mod.ReceiptError, match="diagnostic"):
        build(tmp_path, diagnostic="true")


@pytest.mark.parametrize("mode", ["plain", "luks", ""])
def test_refuses_single_mode_runs(tmp_path, mode):
    with pytest.raises(receipt_mod.ReceiptError, match="both"):
        build(tmp_path, mode=mode)


@pytest.mark.parametrize("path,value,message", [
    (("qualification",), "diagnostic-unqualified", "not-assessed"),
    (("installMode",), "plain", "install mode both"),
    (("producer", "runId"), "4241", "binding producer"),
    (("producer", "runAttempt"), "1", "binding producer"),
    (("producer", "sha"), "d" * 40, "binding producer"),
    (("producer", "artifactName"), "iso-bonito-kde-run4242-a1", "artifact"),
    (("producer", "artifactId"), "777", "artifactId"),
    (("target", "platform"), "linux/amd64/v2", "platform"),
    (("target", "image"), "projectbluefin/dakota:stable", "tuna-os"),
    (("target", "slug"), "skipjack-gnome", "slug"),
    (("iso", "sizeBytes"), 0, "sizeBytes"),
    (("iso", "sha256"), "sha256:abc", "iso.sha256"),
    (("identities", "overlay"), None, "inputs.overlay"),
])
def test_refuses_binding_that_does_not_match_this_run_or_contract(tmp_path, path, value, message):
    bind = binding()
    node = bind
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    with pytest.raises(receipt_mod.ReceiptError, match=message):
        build(tmp_path, bind=bind)


def test_validate_receipt_rejects_input_source_drift(tmp_path):
    receipt = build(tmp_path)
    receipt["inputs"]["source"] = digest("other")
    with pytest.raises(receipt_mod.ReceiptError, match="inputs.source"):
        receipt_mod.validate_receipt(receipt)


def test_validate_receipt_rejects_extra_mode(tmp_path):
    receipt = build(tmp_path)
    receipt["modes"]["tpm"] = deepcopy(receipt["modes"]["luks"])
    with pytest.raises(receipt_mod.ReceiptError, match="both modes"):
        receipt_mod.validate_receipt(receipt)


def run_cli(tmp_path, env, mode="both", diagnostic="false"):
    out = tmp_path / "receipt" / "receipt.json"
    bind = tmp_path / "binding.json"
    bind.write_text(json.dumps(binding()))
    harness_dir(tmp_path)
    r = subprocess.run([sys.executable, str(SCRIPT), "--harness-output", str(tmp_path / f"luks-verify-{SLUG}-obs"),
                        "--binding", str(bind), "--workflow", str(CI_YML), "--slug", SLUG,
                        "--install-mode", mode, "--diagnostic-unqualified", diagnostic, "--out", str(out)],
                       env={**{k: v for k, v in os.environ.items() if not k.startswith("GITHUB_")}, **env},
                       text=True, capture_output=True)
    return r, out


def test_cli_writes_canonical_bytes_and_digest(tmp_path):
    r, out = run_cli(tmp_path, environ())
    assert r.returncode == 0, r.stderr
    raw = out.read_bytes()
    receipt = json.loads(raw)
    assert raw == json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    assert not raw.endswith(b"\n")
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", receipt["qualifiedAt"])
    receipt_mod.validate_receipt(receipt)
    assert receipt["modes"]["plain"] == fragment("plain") and receipt["modes"]["luks"] == fragment("luks")


@pytest.mark.parametrize("env,mode,diagnostic", [
    (environ(GITHUB_REF="refs/heads/topic"), "both", "false"),
    (environ(), "plain", "false"),
    (environ(), "luks", "true"),
])
def test_cli_refuses_with_message_and_writes_nothing(tmp_path, env, mode, diagnostic):
    r, out = run_cli(tmp_path, env, mode, diagnostic)
    assert r.returncode == 1
    assert r.stderr.startswith("qualification receipt refused:")
    assert not out.exists()


# --- workflow wiring ---------------------------------------------------------

WORKFLOW = yaml.safe_load(CI_YML.read_text())
JOB = WORKFLOW["jobs"]["full-matrix"]
STEPS = JOB["steps"]


def step(name):
    return next(s for s in STEPS if s.get("name", "").startswith(name))


def index(name):
    return STEPS.index(step(name))


def test_job_permissions_widen_only_for_attestation():
    assert WORKFLOW["permissions"] == {"contents": "read"}
    assert JOB["permissions"] == {"contents": "read", "id-token": "write", "attestations": "write"}


def test_receipt_is_built_only_after_a_passed_both_mode_run_on_main():
    build_step = step("build qualification receipt")
    cond = build_step["if"]
    for clause in ("success()", "github.ref == 'refs/heads/main'",
                   "github.event.inputs.strict_install_mode == 'both'",
                   "github.event.inputs.diagnostic_unqualified == 'false'",
                   "steps.strict-guest.outcome == 'success'"):
        assert clause in cond
    assert build_step["run"].strip() == "just full-qualification-receipt"
    assert step("verify exact retained ISO")["id"] == "strict-guest"
    # Harness output is root-owned until the label step hands it back.
    assert index("verify exact retained ISO") < index("label diagnostic output") < index("build qualification receipt")


def test_receipt_is_attested_with_a_pinned_action_then_verified_and_uploaded():
    attest = step("attest qualification receipt")
    assert re.fullmatch(r"actions/attest-build-provenance@[0-9a-f]{40}", attest["uses"])
    assert attest["with"] == {"subject-path": "${{ runner.temp }}/qualification-receipt/receipt.json"}
    assert "steps.qualification-receipt.outcome == 'success'" in attest["if"]
    verify = step("verify qualification receipt attestation bundle")
    assert verify["env"]["BUNDLE_PATH"] == "${{ steps.attest-receipt.outputs.bundle-path }}"
    assert verify["run"].strip() == "just full-qualification-receipt-verify"
    upload = step("upload qualification receipt")
    assert upload["with"]["name"] == ("qualification-receipt-${{ matrix.edition.slug }}"
                                      "-run${{ github.run_id }}-a${{ github.run_attempt }}")
    assert upload["with"]["if-no-files-found"] == "error"
    assert "receipt.json" in upload["with"]["path"] and "bundle.jsonl" in upload["with"]["path"]
    assert index("build qualification receipt") < index("attest qualification receipt") \
        < index("verify qualification receipt attestation bundle") < index("upload qualification receipt") \
        < len(STEPS) - 1


@needs_just
def test_verify_recipe_checks_the_consumer_flags_and_certificate_run(tmp_path):
    temp = tmp_path / "temp"
    (temp / "qualification-receipt").mkdir(parents=True)
    (temp / "qualification-receipt/receipt.json").write_bytes(b"{}")
    bundle = tmp_path / "attestation.jsonl"
    bundle.write_text('{"bundle":1}\n')
    bindir = tmp_path / "bin"
    bindir.mkdir()
    calls = tmp_path / "gh-calls"
    cert = {"runInvocationURI": "https://github.com/tuna-os/iso-builder/actions/runs/4242/attempts/2",
            "sourceRepositoryDigest": SHA}
    (tmp_path / "verify.json").write_text(json.dumps([{"verificationResult": {"signature": {"certificate": cert}}}]))
    gh = bindir / "gh"
    gh.write_text(f'#!/bin/sh\necho "$@" >> {calls}\ncat {tmp_path / "verify.json"}\n')
    gh.chmod(0o755)
    env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}", "RUNNER_TEMP": str(temp),
           "BUNDLE_PATH": str(bundle), "GITHUB_SERVER_URL": "https://github.com",
           "GITHUB_REPOSITORY": "tuna-os/iso-builder", "GITHUB_RUN_ID": "4242", "GITHUB_RUN_ATTEMPT": "2",
           "GITHUB_SHA": SHA}
    run = lambda: subprocess.run(["just", "--justfile", str(ROOT / "justfile"), "--working-directory", str(tmp_path),
                                  "full-qualification-receipt-verify"], env=env, text=True, capture_output=True)
    r = run()
    assert r.returncode == 0, r.stdout + r.stderr
    assert (temp / "qualification-receipt/bundle.jsonl").read_text() == '{"bundle":1}\n'
    args = calls.read_text().split()
    for flag, value in (("--repo", "tuna-os/iso-builder"),
                        ("--signer-workflow", "tuna-os/iso-builder/.github/workflows/ci.yml"),
                        ("--source-ref", "refs/heads/main")):
        assert args[args.index(flag) + 1] == value
    assert args[args.index("--bundle") + 1].endswith("qualification-receipt/bundle.jsonl")
    env["GITHUB_RUN_ATTEMPT"] = "1"
    assert run().returncode != 0
