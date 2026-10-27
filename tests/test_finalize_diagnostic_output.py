"""Diagnostic guest output must not expose canonical qualification receipts."""

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/finalize-diagnostic-output.py"


def test_nested_qualification_receipts_are_renamed_and_output_is_marked(tmp_path):
    output = tmp_path / "luks-verify-skipjack-gnome-same-byte-diagnostic-unqualified"
    nested = output / "strict-diagnostics" / "receipts"
    nested.mkdir(parents=True)
    receipt = {"schema": "QualificationEvidence/v1", "qualifiedAt": "2026-10-27T00:00:00Z"}
    canonical = nested / "qualification-evidence.json"
    canonical.write_text(json.dumps(receipt))

    result = subprocess.run([sys.executable, str(SCRIPT), str(output)], text=True, capture_output=True)

    assert result.returncode == 0, result.stderr
    assert not list(output.rglob("qualification-evidence.json"))
    renamed = nested / "diagnostic-unqualified-evidence.json"
    assert json.loads(renamed.read_text()) == receipt
    assert (output / "DIAGNOSTIC-UNQUALIFIED.txt").read_text() == (
        "diagnostic-unqualified: this guest output does not qualify a target\n"
    )


def test_finalizer_preserves_existing_diagnostic_receipt(tmp_path):
    output = tmp_path / "guest-output"
    output.mkdir()
    existing = output / "diagnostic-unqualified-evidence.json"
    existing.write_text('{"existing":true}')
    canonical = output / "qualification-evidence.json"
    canonical.write_text('{"canonical":true}')

    result = subprocess.run([sys.executable, str(SCRIPT), str(output)], text=True, capture_output=True)

    assert result.returncode == 0, result.stderr
    assert not list(output.rglob("qualification-evidence.json"))
    assert json.loads(existing.read_text()) == {"existing": True}
    assert json.loads((output / "diagnostic-unqualified-evidence-2.json").read_text()) == {"canonical": True}
