# `tunaos-media-helper` protocol (version 1)

The TunaOS Media Writer GUIs (macOS SwiftUI, Windows WinUI 3, Linux GTK4) never
build or write anything themselves. They spawn `tunaos-media-helper`, a Go CLI
in [`helper/`](helper/) that wraps the tacklebox engine (the same engine the
browser WASM build and `purebuild` use), and read its events.

## Transport

Every subcommand writes **JSON Lines** events (one JSON object per line, UTF-8)
to stdout, or to the file given by `--events PATH` (append; needed when the
helper runs elevated through an OS prompt that does not forward stdout — macOS
`osascript ... with administrator privileges`, Windows `ShellExecute runas`).
Human logs go to stderr.

Exit codes: `0` = success, `1` = failure (an `error` event precedes it),
`2` = usage error, `130` = cancelled (SIGINT/SIGTERM, or Windows
CTRL_BREAK; also: the GUI may create the file `--cancel-file PATH` and the
helper polls it every second).

`--events PATH` and `--cancel-file PATH` are accepted by every subcommand.

## Common events

```
{"event":"progress","phase":"download|unpack|overlay|erofs|esp|iso|write|verify","current":123,"total":456,"unit":"bytes|layers|steps","message":"Unpacking layer 3/12"}
{"event":"log","level":"info|warn","message":"..."}
{"event":"error","kind":"network|storage|permission|device-changed|verify-mismatch|engine|cancelled|usage","message":"human readable, one sentence"}
```

`total` is `0` when unknown. GUIs must ignore unknown fields and unknown
`event` values.

## Subcommands

1. `version` →
   `{"event":"version","helper":"<semver>","engine":"<tacklebox module version>","protocol":1}`

2. `catalog [--base-url https://iso.tunaos.org]` → fetches
   `catalog-snapshot.json`, `builder-config.json` and `guided-catalog.json`
   from the base URL (falls back to a copy embedded at build time if offline,
   and says so with a `log` warn), and emits

   ```
   {"event":"catalog","snapshotDigest":"sha256:...","defaultTarget":"yellowfin:gnome:linux/amd64",
    "desktops":[{"id":"gnome","label":"GNOME","description":"..."}],
    "bases":[{"id":"yellowfin","label":"AlmaLinux Kitten 10 (flagship)"}],
    "targets":[{"id":"yellowfin:gnome:linux/amd64","base":"yellowfin","desktop":"gnome","platform":"linux/amd64",
                "edition":"standard","hardware":"generic","image":"ghcr.io/tuna-os/yellowfin:gnome",
                "compressedSize":1625549436,"browserQualified":false}]}
   ```

   Only selectable, available targets; ordering of desktops/bases follows
   builder-config facet order. GUIs show standard/generic targets for the host
   architecture by default.

3. `build (--target ID | --request build-request.json) --out PATH [--workdir DIR] [--flatpaks default|none|id,id] [--base-url URL]`
   → builds the ISO with the tacklebox engine exactly as the browser does for
   that catalog target (BuildRequest v1 constructed the same way as
   `buildRequestFromForm` in `app/public/app.js`: pinned resolvedInputs,
   per-desktop `default_flatpaks` from builder-config, outputFilename, label).
   Emits progress events, then
   `{"event":"done","path":"/abs/out.iso","bytes":N,"sha256":"..."}`.
   Checks free disk space up front (`kind:"storage"` error with
   required/available GB). Workdir defaults to an OS cache dir and is cleaned
   on exit.

4. `medium --cell REF --out PATH [--resume] [--layout-name NAME]` → stages a
   prepared installer cell with the `tacklebox write-medium` engine. It never
   builds an ISO. `REF` is a registry ref or an OCI layout directory. Emits
   progress events, then
   `{"event":"done","path":"/abs/staged.img","bytes":N,"sha256":"...","manifest":"sha256:...","verified":true}`.
   The engine checks every chunk, the whole stream, and the read-back.
   `verified` covers the staged file; `write` checks the stick again. Pass
   the staged file to `write --iso` as the image. `--resume` keeps the target
   and skips chunks that already match. Signature checks are stubs upstream
   (tuna-os/tacklebox#511): the helper passes `--insecure-skip-verify`, and
   forwards the engine warning as a `log` event.

5. `drives [--exclude PATH]` →
   `{"event":"drives","drives":[{"id":"stable id (disk serial/by-id path or Windows disk number+serial)","path":"/dev/sdb | /dev/disk4 | \\\\.\\PhysicalDrive2","name":"SanDisk Ultra","sizeBytes":N,"bus":"usb|sd|other","removable":true,"mounted":["/media/..."],"systemDisk":false}]}`.
   Never lists the system/boot disk or the disk that holds `--exclude PATH`
   (the ISO's own disk).

6. `write --iso PATH --device ID [--fd N] [--no-verify]` → re-resolves ID
   right before writing and refuses (`device-changed`) if path/size/serial no
   longer match; unmounts/locks/dismounts the disk's volumes (macOS
   `diskutil unmountDisk`, Windows FSCTL_LOCK_VOLUME + FSCTL_DISMOUNT_VOLUME
   on every volume of the disk, Linux: the GUI unmounts via udisks2), writes
   the raw ISO (macOS `/dev/rdiskN`, Windows `\\.\PhysicalDriveN`, 4 MiB
   aligned writes), fsyncs, reads back and compares SHA-256 (`verify` phase)
   unless `--no-verify`, ejects when done. `--fd N` = write to an
   already-open, inherited writable file descriptor instead of opening the
   path (Linux Flatpak: the GUI gets the fd from udisks2
   `Block.OpenDevice("w")` with polkit and passes it). Emits
   `{"event":"done","device":"...","bytes":N,"verified":true}`.

## Opening the app on a target

The website opens a Media Writer on the image the visitor picked. That is a
GUI contract, not a helper subcommand; all three apps implement it the same
way.

```
tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64
<app> --target yellowfin:gnome:linux/amd64
```

- `target` is a catalog target id (the `id` of a `catalog` event target, the
  value `build --target` takes), URL-encoded in the link. An unencoded id is
  accepted too, and so are a slash before `?` (`build/?target=`) and any
  case in the scheme and action.
- Opening one selects that target exactly as if the user had picked it on
  step 1 and pressed Continue: the app shows step 2 (choose a USB stick or
  "Save ISO file only") and waits. It never starts a build or a write; the
  user still picks the drive and confirms the erase. Back returns to step 1
  with that desktop and base selected when step 1 offers them. Any catalog
  target is accepted, including other editions and platforms than step 1
  shows; the app builds exactly the linked id, or fetches the linked cell
  (see below).
- The link may name a cell: `...&cell=REF&digest=sha256:...`. `cell` names
  the prepared installer image to fetch instead of an ISO build. `digest`
  its manifest; the app refuses a staged file whose manifest differs. A
  `build-request.json` with a `cell` field behaves the same; requests
  without one keep the old builder.
- A link that arrives before the catalog has loaded is opened once it has.
- Refused, with a visible message and nothing selected: anything that is not
  `tunaos-media-writer://build` with exactly one `target`; an id not shaped
  `base:desktop:os/arch[/variant]` (lower-case `a-z 0-9 . _ -`); an id the
  catalog does not offer; any link while a build or write is running.
- Cell links add three refusals: more than one `cell` or `digest`; a
  `digest` without `cell`; a `digest` that is not `sha256:` plus 64 hex digits.

| | Scheme registration | A link while the app runs |
|---|---|---|
| Linux | `MimeType=x-scheme-handler/tunaos-media-writer;` and `Exec=tunaos-media-writer %u` in the desktop file (Flatpak exports it) | `GApplication` is unique: the second launch forwards its command line to the running window and exits |
| macOS | `CFBundleURLTypes` in `Info.plist`; SwiftUI `onOpenURL` | Launch Services delivers it to the running app's one window |
| Windows | The MSI writes `HKCR\tunaos-media-writer` (`URL Protocol`, `shell\open\command` = `"…\TunaOSMediaWriter.exe" "%1"`), removed on uninstall | A new instance (the app has no single-instance mode) |

## Release assets

`media-writer-release.yml` publishes, under stable names the website links as
`https://github.com/tuna-os/iso-builder/releases/latest/download/<name>`:
`TunaOS-Media-Writer-macOS.dmg`, `TunaOS-Media-Writer-Windows-x64.msi`,
`TunaOS-Media-Writer-Linux-x86_64.flatpak`,
`TunaOS-Media-Writer-Linux-aarch64.flatpak` (when built), `SHA256SUMS` (over
the app assets) and `signing.json`:

```
{"schemaVersion":1,"macos":"developer-id-notarized|adhoc","windows-x64":"authenticode|unsigned",
 "linux-x86_64":"unsigned","linux-aarch64":"unsigned"}
```

`linux-aarch64` is present only when that bundle is. The website shows
"first launch: right-click → Open" (macOS) / "More info → Run anyway"
(Windows) only for `adhoc` / `unsigned`.

The values record what the platform jobs actually did, never secret presence:
`media-writer-macos.yml` uploads an artifact named `signing-macos` holding
`signing-macos.json` = `{"macos":"developer-id-notarized"}` only after
signing, notarization and stapling succeeded, else `{"macos":"adhoc"}`;
`media-writer-windows.yml` uploads `signing-windows-x64` holding
`signing-windows-x64.json` = `{"windows-x64":"authenticode"}` only after the
MSI's Authenticode signature verified, else `{"windows-x64":"unsigned"}`.
The release fails if either is missing or holds another value. Flatpak
bundles are not signed by any job.
