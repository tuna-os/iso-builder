# iso-builder #3797 same-byte diagnostic handoff

## Current observed boundary

Run [40538072100](https://github.com/actions/runs/40538072100) on iso-builder main `4a0e1c34be84e87ce400414ed9f0bc2f1c309ce1` built the Skipjack/GNOME ISO, round-tripped its GitHub artifact, and verified the ISO hash. Preparation stopped before any guest boot with `ISO has no embedded etc/tunaos/live-source.json receipt`.

The retained diagnostic artifact (ID `12750324651`) contains browser measurements and the artifact manifest; its guest output contains only the `DIAGNOSTIC-UNQUALIFIED.txt` marker. It does not preserve per-payload `unsquashfs` status, filesystem-format output, or stderr. The measurement records an applied overlay with `baseAnnotationMatched=false`, and the observed source manifest differs from the pre-build catalog digest. These facts do not distinguish absent metadata from an extraction/path/format error and do not establish the root cause.

No unchanged ISO was retried; the retained run remains diagnostic-unqualified.

## Changed behavior

- `.github/workflows/ci.yml` passes a diagnostic-log path to the receipt helper; the always-run diagnostics artifact includes that file.
- `scripts/prepare-browser-selftest.py` records bounded per-payload `unsquashfs -s` format summaries and receipt-member path, status, exit code, and error text. Missing or unreadable receipts still fail before guest execution and produce no environment binding or qualification sidecar.
- `tests/test_prepare_browser_selftest.py` covers a valid SquashFS with absent receipt paths, an invalid SquashFS superblock, error text truncation/control-character removal, and diagnostic retention on helper failure.
- The integration plan and candidate-retention guide distinguish the exercised GitHub artifact path from the unused R2 path and record run 40538072100's failure.

## Verification and limits

`python3 -m pytest -q tests/test_prepare_browser_selftest.py tests/test_iso_artifact_retention.py tests/test_ci_evidence_upload.py` — 44 passed, 14 cleanup warnings from existing root-owned test fixtures. `actionlint .github/workflows/ci.yml` passed.

The test uses temporary payloads and a controlled `unsquashfs` executable; it does not inspect the 9.4 GB retained ISO. No hosted browser workflow, actual ISO extraction, guest boot, or qualification was run for this diagnostic patch. The existing run [40538072100](https://github.com/actions/runs/40538072100) still stopped before guest execution.

## Remaining acceptance

Do not retry the same ISO bytes. First establish a same-base overlay carrying a valid `live-source.json` receipt whose source identity matches the browser build; inspect the retained per-payload diagnostics on that run. Producer/frontend authentication, a real media-bound installer frontend identity, strict plain/LUKS installation on browser-produced bytes, detached cold/warm boots, and three paired cold/warm measurements remain outstanding. Diagnostic evidence never qualifies a target or authorizes R2/cutover.
