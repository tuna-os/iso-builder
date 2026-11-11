# TunaOS Media Writer — macOS

SwiftUI app (macOS 13+, universal arm64 + x86_64, bundle id
`org.tunaos.MediaWriter`) that walks a user through **Choose → USB stick →
Create → Done**. All building and writing is done by the bundled
`tunaos-media-helper` (see [`../PROTOCOL.md`](../PROTOCOL.md)); the app only
spawns it and reads its JSON Lines events.

## Layout

| Path | What |
|---|---|
| `Package.swift` | SwiftPM package, no Xcode project |
| `Sources/MediaWriterCore/` | Everything without UI: protocol models + JSONL parser (`HelperEvents.swift`, `JSONLines.swift`), process launching incl. elevation (`HelperClient.swift`), the flow as a pure reducer (`FlowState.swift`), its side effects (`FlowController.swift`), every user-visible string (`Strings.swift`) |
| `Sources/TunaOSMediaWriter/` | SwiftUI views, app entry, `--ui-smoke` driver |
| `Tests/MediaWriterCoreTests/` | XCTest: parser, helper client, state machine, end-to-end flow against the fake helper |
| `Fixtures/fake-helper.sh` | Protocol-1 stand-in used by tests and the UI smoke; never touches a disk |
| `Resources/Info.plist` | Bundle metadata (version filled in by `build-app.sh`) |
| `scripts/` | `build-helper.sh` (helper + engine, both arches, `lipo`), `build-app.sh` (bundle, icon, signing), `make-dmg.sh`, `ui-smoke.sh` |

## Build

Needs Xcode (for the multi-arch `swift build`) and Go.

```sh
cd desktop/macos
swift test                                   # unit tests, fake helper only
scripts/build-helper.sh                      # build/helper/{tunaos-media-helper,tunaos-media-engine}
scripts/build-app.sh                         # build/TunaOS Media Writer.app (ad-hoc signed)
scripts/make-dmg.sh                          # build/TunaOS-Media-Writer-macOS.dmg
scripts/ui-smoke.sh                          # build/ui-smoke/{usb,iso,fail}/*.png
```

The helper runs tacklebox's `cmd/purebuild` as a sibling binary
(`tunaos-media-engine`), so both are bundled in `Contents/MacOS/`.

Development switches (ignored unless passed on the command line):

- `--fake-helper PATH` — use `Fixtures/fake-helper.sh` instead of the bundled
  helper. Writes then go through the same `--events`/`--cancel-file` path as
  the elevated write, but unprivileged and without a password prompt.
- `--ui-smoke DIR [--ui-smoke-scenario usb|iso|fail]` — the app walks its own
  window through the flow and saves per step `NN-step.png` (`screencapture -l`),
  `-screen.png` (whole screen, shows the erase sheet), `-view.png` (in-process
  render) and `NN-step.json` (state), then exits 0/1.
- `--catalog-base-url URL` — forwarded to `helper catalog --base-url`.

## Decisions

**Elevation via `osascript … with administrator privileges`.** Only the
`write` step needs root (raw `/dev/rdiskN`). The app runs
`/bin/sh -c '<helper> write … --events F --cancel-file C 2>>LOG; echo $? >EXIT'`
through `do shell script … with administrator privileges` and tails `F` for
progress (`do shell script` returns nothing until the command ends). Cancel
creates `C`; the root process cannot be signalled by the app. The exit status
goes through a file because `do shell script` only reports it inside an error
string; a dismissed password prompt (`-128`) returns the user to the USB step.
`SMAppService.daemon` / a privileged helper tool was not used yet because it
needs a Developer ID–signed app with a matching designated requirement
(launchd refuses to bless an ad-hoc signed daemon), a launchd plist, an XPC
protocol, and an approval step in System Settings — none of which can work
while the project ships unsigned builds (`native/package/README.md`). Revisit
once Developer ID signing exists.

**Drive hotplug by polling.** `helper drives` runs every 2 s while the USB
step is visible (and only then). It reuses the helper's diskutil-based safety
filters (system disk and the disk holding the staging directory are excluded)
instead of reimplementing them with DiskArbitration in Swift.

**Default to Intel/AMD PC images.** The contract says "host architecture by
default", but a Mac is not where these images boot (Apple Silicon Macs cannot
boot them at all): the stick is for a PC. The app therefore defaults to
`linux/amd64` and offers ARM PC images under *More options* when the catalog
has them.

**Where the ISO goes.** For a USB write, the ISO is built into
`~/Library/Caches/org.tunaos.MediaWriter/`, kept if the write fails (so
*Try again* skips the rebuild) and deleted after a successful write. *Save ISO
file only…* builds straight to the chosen path.

## Signing

`media-writer-macos.yml` signs with a Developer ID and notarizes only when
the repository secrets `MACOS_CERT_P12` (base64 .p12), `MACOS_CERT_PASSWORD`
(+ optional `MACOS_SIGN_IDENTITY`) and `AC_API_KEY` (base64 .p8),
`AC_API_KEY_ID`, `AC_API_ISSUER_ID` exist. Otherwise everything is ad-hoc
signed and the job summary says **unsigned**: Gatekeeper then blocks the first
launch until the user right-clicks the app → Open.

Every run (including `workflow_call`) also uploads the artifact
`signing-macos` with `signing-macos.json`: `{"macos":"developer-id-notarized"}`
only when the notarize step (Developer ID signature, notarization, staple,
validation) actually succeeded, otherwise `{"macos":"adhoc"}`.
`media-writer-release.yml` turns it into the release's `signing.json`.
