# TunaOS Media Writer — Linux

GTK4 + libadwaita app (Python 3 + PyGObject), shipped as a Flatpak bundle
`TunaOS-Media-Writer-Linux-<arch>.flatpak` with app id `org.tunaos.MediaWriter`.
It is a front end for `tunaos-media-helper` ([`../PROTOCOL.md`](../PROTOCOL.md)),
which the Flatpak bundles together with its sibling engine `tunaos-media-engine`.

## Layout

| Path | What |
|---|---|
| `tunaos_media_writer/protocol.py` | JSONL event parser (protocol v1) |
| `tunaos_media_writer/catalog.py` | `catalog` event model, host-arch standard/generic defaults |
| `tunaos_media_writer/flow.py` | the four-step flow as a pure state machine |
| `tunaos_media_writer/helper.py` | `Gio.Subprocess` wrapper: events from stdout, stderr kept for "Show details" |
| `tunaos_media_writer/udisks.py` | udisks2 over GDBus: hotplug, unmount/lock, `Block.OpenDevice` |
| `tunaos_media_writer/controller.py` | runs helper subcommands and udisks2 calls, feeds the flow |
| `tunaos_media_writer/window.py` | `AdwApplicationWindow` + `AdwNavigationView`, one page per step |
| `tunaos_media_writer/strings.py` | every user-visible string (gettext-ready) |
| `org.tunaos.MediaWriter.yml` | Flatpak manifest (GNOME 51 runtime, Go SDK extension for the helper) |
| `data/` | desktop file, AppStream metainfo, icon |
| `tests/` | pytest suite, `fake_helper.py`, UI smoke, loop-device write test |

## How writing works (no `/dev` access in the sandbox)

1. The ISO is built first (`helper build … --out ~/.var/app/org.tunaos.MediaWriter/cache/tunaos-media-writer/<name>.iso`); no prompt.
2. Only then, for the write step: every mounted filesystem on the chosen disk
   (and unlocked LUKS cleartext devices) is unmounted through udisks2
   (`Filesystem.Unmount`, `Encrypted.Lock`).
3. `Block.OpenDevice("rw", {flags: O_EXCL})` — this is the polkit prompt
   (`org.freedesktop.udisks2.open-device`). `"rw"`, not `"w"`, because the
   helper reads back through the same fd for its verify phase; `O_EXCL` fails
   if anything still holds the disk.
4. The fd is handed to the helper with `Gio.SubprocessLauncher.take_fd` as
   fd 3: `tunaos-media-helper write --iso … --device <id> --fd 3`.

Drives come from the helper's `drives` (the safety filter), cross-checked
with udisks2: a drive is offered only if udisks2 knows its block device and
does not flag it `HintSystem`. The list refreshes on udisks2 hotplug signals
and every 2 s while the destination page is open. Inside the sandbox `lsblk`
sees `/sys` but not `/run/udev`, so model/serial can be empty there; the name
then comes from udisks2 (`Drive.Vendor`/`Model`).

A built ISO is kept for the session so "Try again" after a failed write does
not rebuild; it is deleted on quit or when a different system is built.

## Run from source

```bash
cd desktop/linux
python3 -m tunaos_media_writer --fake-helper tests/fake_helper.py   # fake helper, no udisks2
TUNAOS_MEDIA_HELPER=/path/to/tunaos-media-helper python3 -m tunaos_media_writer
```

Needs GTK ≥ 4.10 and libadwaita ≥ 1.5 (Ubuntu 24.04 works; the Flatpak ships
GNOME 51). `--fake-helper PATH` runs that executable instead of the helper
and skips udisks2; the fake helper's "drives" are image files under
`$FAKE_HELPER_DIR`.

## Tests

```bash
cd desktop/linux
python3 -m pytest                      # protocol, catalog, flow, controller (fake helper, real GLib loop)
xvfb-run -a dbus-run-session -- python3 tests/ui_smoke.py --out /tmp/shots   # walks all steps, PNG per step
sudo python3 tests/loop_e2e.py         # udisks2 loop device: unmount → OpenDevice → write --fd → verify
```

`loop_e2e.py` never touches a real disk: it creates a file-backed loop
device, mounts a FAT filesystem on it, and runs the controller's write step.
With `TUNAOS_MEDIA_HELPER` set it uses the real helper, which must be built
with `-tags testdevices` (it then accepts the loop device through
`TUNAOS_MEDIA_HELPER_TEST_DEVICES`; release builds ignore that variable).

## Build the Flatpak

```bash
flatpak-builder --user --install-deps-from=flathub --force-clean \
  --repo=repo build desktop/linux/org.tunaos.MediaWriter.yml
flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  repo TunaOS-Media-Writer-Linux-x86_64.flatpak org.tunaos.MediaWriter
```

The helper module downloads Go modules, so it builds with `--share=network`
(fine for our own bundle; Flathub would need vendored sources).

CI: [`.github/workflows/media-writer-linux.yml`](../../.github/workflows/media-writer-linux.yml)
builds x86_64 and aarch64 bundles in `ghcr.io/flathub-infra/flatpak-github-actions:gnome-51`,
then installs each bundle on a clean runner and runs, inside the sandbox, the
helper (`version`, `drives`, `catalog`), the pytest suite against the
installed code, and the UI smoke (screenshots uploaded as
`media-writer-linux-screenshots-<arch>`). It also runs as `workflow_call` for
the release workflow.

## Signing

The bundle is unsigned; integrity comes from the release's `SHA256SUMS`
(see the job summary of each build).

## Not covered automatically

- The polkit prompt itself (CI and the loop test run with root authority).
- Writing a physical USB stick.
