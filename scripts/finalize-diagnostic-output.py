#!/usr/bin/env python3
"""Mark strict guest outputs as diagnostic and rename qualification receipts."""

from __future__ import annotations

import argparse
from pathlib import Path

MARKER = "diagnostic-unqualified: this guest output does not qualify a target\n"
RECEIPT = "qualification-evidence.json"
DIAGNOSTIC_RECEIPT = "diagnostic-unqualified-evidence.json"


def finalize(output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "DIAGNOSTIC-UNQUALIFIED.txt").write_text(MARKER)

    renamed = []
    for receipt in sorted(output_dir.rglob(RECEIPT)):
        destination = receipt.with_name(DIAGNOSTIC_RECEIPT)
        suffix = 2
        while destination.exists():
            destination = receipt.with_name(f"diagnostic-unqualified-evidence-{suffix}.json")
            suffix += 1
        receipt.rename(destination)
        renamed.append(destination)

    remaining = list(output_dir.rglob(RECEIPT))
    if remaining:
        names = ", ".join(str(path) for path in remaining)
        raise RuntimeError(f"canonical qualification receipt remains in diagnostic output: {names}")
    return renamed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    renamed = finalize(args.output_dir)
    print(f"marked diagnostic-unqualified output; renamed {len(renamed)} qualification receipt(s)")


if __name__ == "__main__":
    main()
