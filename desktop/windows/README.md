# TunaOS Media Writer — Windows

WinUI 3 (Windows App SDK 1.8, .NET 10, C#) app that walks a non-technical user
through the four steps of the shared flow (`../PROTOCOL.md`, contract in the PR):
**Choose** a desktop + base → **Destination** (a USB stick, or "Save ISO file only…")
→ **Progress** → **Done**. It drives the bundled Go helper
`tunaos-media-helper.exe` (plus its sibling engine `tunaos-media-engine.exe`) over
JSON Lines; no terminal, no Go toolchain.

Release asset: `TunaOS-Media-Writer-Windows-x64.msi` (Windows 10 1809+ / 11, x64).

## Layout

| Path | What |
|---|---|
| `src/MediaWriter.Core` | Platform-neutral `net10.0` library: protocol events + JSONL parser (`Protocol/`), helper process runner (`Helper/`), catalog view, progress mapping, the flow state machine (`MediaWriterFlow`) and every user-facing string (`Strings.cs`, one place for localization). |
| `src/MediaWriter.App` | WinUI 3 shell: one window, a `Frame` with one page per step, `ContentDialog` for the erase confirmation, `FileSavePicker` / `FileOpenPicker`, `ProgressBar`, `InfoBar` for errors. `Smoke/` is the `--smoke` driver and window capture. |
| `tests/MediaWriter.Core.Tests` | xUnit: parser, line buffer, quoting, catalog view, progress mapping, the flow state machine against a scripted in-process fake, and the real process runner against `smoke/fake-helper.ps1`. |
| `installer` | WiX v5 SDK project → per-machine MSI, Program Files, Start-menu shortcut. |
| `smoke/fake-helper.ps1` | Protocol-v1 fake helper (canned catalog, two fake sticks, slow progress); never opens a disk. |
| `smoke/run-ui-smoke.ps1` | Launches the app in `--smoke` mode for one scenario and fails if it does. |

## How it talks to the helper

* `catalog`, `drives`, `build` run unelevated with stdout redirected and parsed line by
  line (`ProcessHelperRunner`). `build` gets `--cancel-file`; Cancel creates the file and
  the helper stops (exit 130); the process is killed only if it ignores that for 15 s.
* `write` is the only step that needs administrator rights. It is started with
  `ShellExecute` verb `runas` (the UAC prompt names the helper) with
  `--events <tmp>.jsonl --cancel-file <tmp>.cancel`; the app tails the events file every
  200 ms (`JsonlLineBuffer` handles half-written lines and split UTF-8). Saying No to UAC
  (`ERROR_CANCELLED`) becomes a plain-words error with "Try again". A non-elevated parent
  cannot kill an elevated child, so the cancel file is the only stop signal there.
  The elevated helper does not inherit the app's stderr, so "Show details" shows its
  `log`/`error` events for that step.
* Drive hotplug: the destination page re-runs `drives --exclude <cache dir>` every 2 s
  (overlapping calls are dropped, the list only re-renders when it changed). Polling was
  chosen over `Win32_VolumeChangeEvent` because it also catches sticks without a
  mountable volume and re-partitioned sticks, and needs no WMI permission.
* For a USB write the ISO is built into `%LOCALAPPDATA%\TunaOS Media Writer\cache`, kept
  if the write fails (so "Try again" does not rebuild), and deleted after a successful
  write and when the window closes.
* Sizes use decimal units (a 16 GB stick shows "15.4 GB"), matching the label on the stick.

## Build

Needs Windows, the .NET 10 SDK and Go (version from `../helper/go.mod`).

```powershell
cd desktop/windows
dotnet test tests/MediaWriter.Core.Tests            # also runs on Linux/macOS (pwsh needed for the process tests)

# helper + engine (see ../helper)
mkdir build/helper
pushd ../helper
$env:CGO_ENABLED='0'; $env:GOOS='windows'; $env:GOARCH='amd64'
go build -trimpath -o ../windows/build/helper/tunaos-media-helper.exe ./cmd/tunaos-media-helper
Remove-Item env:GOOS, env:GOARCH
go run ./cmd/build-engine -goos windows -goarch amd64 -o ../windows/build/helper/tunaos-media-engine.exe
popd

dotnet publish src/MediaWriter.App -c Release -r win-x64 -p:Platform=x64 -p:HelperDir=$pwd/build/helper -o build/app
dotnet build installer/MediaWriter.Installer.wixproj -c Release -p:AppDir=$pwd/build/app -p:ProductVersion=0.1.0
```

## Test / smoke switches

These exist for CI and development; a normal launch has no arguments.

* `--fake-helper smoke\fake-helper.ps1` — use the fake helper (PowerShell) instead of
  the bundled one. `FAKE_HELPER_FAIL=catalog|build|write` makes that step fail.
* `--no-elevate` — start the write step without the `runas` verb (still via the events file).
* `--smoke DIR [--smoke-scenario write|error|save|launch]` — the app walks the flow on
  its own, saves window screenshots (`PrintWindow` with `PW_RENDERFULLCONTENT`, screen copy
  as fallback) and `smoke.log` to `DIR`, and exits 0/1. Every scenario except `launch`
  refuses to start without `--fake-helper`, so a smoke run can never write to a real disk;
  `launch` (used against the installed MSI) only loads the catalog and lists drives.

CI: `.github/workflows/media-writer-windows.yml` on `windows-latest` runs the tests,
builds helper + engine + app + MSI, runs the four smoke scenarios against the publish
folder, installs the MSI (`msiexec /i … /qn`), runs `launch` (real helper) and `write`
(fake helper) from Program Files, uninstalls it and checks nothing is left. Screenshots
and logs: artifact `windows-ui-smoke`. It is also a `workflow_call` target for the
release workflow (input `version`, optional secrets below).

## Signing

Authenticode only when the repository secrets `WINDOWS_CERT_PFX` (base64 .pfx) and
`WINDOWS_CERT_PASSWORD` exist: app, helper, engine and MSI are signed with an RFC 3161
timestamp. Without them the job summary says **unsigned**, and SmartScreen warns on first
run ("More info" → "Run anyway") — see `native/package/README.md` for why no certificate
exists yet.
