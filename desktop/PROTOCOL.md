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

4. `drives [--exclude PATH]` →
   `{"event":"drives","drives":[{"id":"stable id (disk serial/by-id path or Windows disk number+serial)","path":"/dev/sdb | /dev/disk4 | \\\\.\\PhysicalDrive2","name":"SanDisk Ultra","sizeBytes":N,"bus":"usb|sd|other","removable":true,"mounted":["/media/..."],"systemDisk":false}]}`.
   Never lists the system/boot disk or the disk that holds `--exclude PATH`
   (the ISO's own disk).

5. `write --iso PATH --device ID [--fd N] [--no-verify]` → re-resolves ID
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
