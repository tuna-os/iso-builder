# iso-builder #3797 same-byte diagnostic handoff

## Current observed boundary

Run [40538072100](https://github.com/tuna-os/iso-builder/actions/runs/40538072100) on iso-builder main `4a0e1c34be84e87ce400414ed9f0bc2f1c309ce1` built the Skipjack GNOME ISO and verified the artifact hash. The helper stopped before guest boot because it found no `etc/tunaos/live-source.json` receipt.

The retained artifact (ID `12750324651`) has browser measurements and the ISO manifest. Its guest folder has only the `DIAGNOSTIC-UNQUALIFIED.txt` marker. It has no `unsquashfs` results for each payload. The report says the overlay applied, but `baseAnnotationMatched=false`. The source digest from the build differs from the earlier catalog digest. These facts do not show the cause.

We did not retry these bytes. The run stays diagnostic-unqualified.

## Changed behavior

- `.github/workflows/ci.yml` passes a path for the receipt log. The upload step keeps this log when the helper fails.
- The helper saves a short report for each payload. It checks the format, then lists each receipt path before reading it. A successful listing can prove a member absent; a format, listing or read error cannot. Any unreadable payload blocks guest tests, even when another payload supplies valid receipts. No environment file or binding is written on failure.
- Tests use real tiny SquashFS images to check valid receipts beside absent members, a corrupt superblock, and truncated metadata. A separate read-failure case proves that another valid payload cannot hide an unread receipt.
- The integration plan and retention guide show the GitHub artifact route and the separate R2 route. They record run 40538072100.

## Verification and limits

The focused helper, artifact-retention and upload tests cover diagnostic failure handling. They do not read the 9.4 GB artifact or boot a guest. Run [40538072100](https://github.com/tuna-os/iso-builder/actions/runs/40538072100) stopped before any guest test; no hosted full-media run has used this patch.

## Remaining acceptance

Do not retry the same bytes. Build a new overlay from the same base. Add a valid `live-source.json` receipt. The receipt must name the source digest from the browser measurements. Inspect the new log before guest tests.

The producer and browser frontend remain unauthenticated. The media has no verified digest for its installer app.

Run strict plain install tests on browser-built bytes. Run encrypted install tests too. Then test cold boot and reboot with the ISO removed.

Measure three cold builds and three warm builds under the same inputs. Show that warm builds transfer no complete image layers.

Do not claim qualification or performance. Do not change R2 or cutover.
