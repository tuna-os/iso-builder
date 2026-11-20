# Browser quickstart

## One-click download (the default page)

[iso.tunaos.org](https://iso.tunaos.org) opens on one screen: pick a desktop,
optionally change **Based on**, and press the one button. What the button does
depends on evidence, not preference (`app/public/quick-start.js`):

1. **Download ISO, built in your browser.** The page uses this route only when
   two conditions are true. The catalog has a complete receipt of browser
   qualification for the image. This browser can build it. The browser needs
   WebAssembly and private browser storage. It needs at least 4 GB of device
   memory, when the browser reports it. It needs 9.5 GB of free storage, or
   19 GB without the save dialog. The save dialog opens first. Then the build
   runs in the tab with the default apps of the desktop.
2. **Download ISO, ready-made.** The page uses this route when
   download.tunaos.org has an ISO for the image.
3. **Get TunaOS Media Writer.** The page uses this route when the native app
   (`desktop/`) has a release. The app builds the image on your computer. It
   also writes the USB stick.
4. **Build on your computer.** The page shows the local instructions of the
   full builder.

TunaOS Media Writer can have a release for your operating system. Then the
page also shows it under the button on every route: **Write it to a USB stick
with TunaOS Media Writer**. Two links follow the download button:

- **Open in Media Writer** opens the installed app on the selected image
  (`tunaos-media-writer://build?target=<catalog target id>`, for example
  `yellowfin:gnome:linux/amd64`). The app does not write anything until you
  confirm.
- **Download this image's build request** saves `build-request.json` for the
  image, with the default apps of its desktop. In the app, choose
  **Open build request…** and select that file.

On macOS 15 and newer, an unsigned app opens only after you choose
**Open Anyway** in **System Settings → Privacy & Security**. The app writes a
USB stick for a PC. A Mac with Apple Silicon cannot start from that stick.

The links to ready-made ISOs and app releases come from `downloads.json`.
The deploy job makes this file with `scripts/generate-downloads.py`. The
script reads the published ISO index and the GitHub releases. If the script
cannot read a source, the page does not show that route. Thus the page never
links to a missing file. tunaos.org reads the same file from its download
page, so `app/public/_headers` serves it (and `catalog-snapshot.json`) with
`Access-Control-Allow-Origin: *`.

This page shows only standard, generic x86-64 images. A link that names only
a TunaOS image, as tunaos.org sends
(`?image=tuna-os/bonito:kde`, optionally with `&platform=linux/amd64`), opens
this page on that desktop and base. If the page does not offer that image,
the link opens the full builder.
**Customize apps and settings** (or any other URL parameter, such as
`?customize=1` or a share link) opens the full builder described below, on
the same image.

## The full builder

Open the full builder ([iso.tunaos.org/?customize=1](https://iso.tunaos.org/?customize=1))
to choose any image and check whether you can build it in your browser. The
build runs on your computer and saves an ISO file. You must then write that
file to a USB drive to make it bootable.

## Choose and check an image

1. Keep **Experience** set to **TunaOS**. Other experiences can be previews
   with inspection and ISO creation disabled.
2. Under **Choose your image**, use **Start with a desktop** or **Start with a
   base**. Answer the questions for your desktop, base, image edition and
   computer. The picker skips questions when only one choice remains.
   Follow **Next: …**, then **Review images**. Choose an available result with
   **Use this image**, or review the current **Selected image**. Check its
   computer architecture and **Image details** before you continue. Disabled
   choices show why they are unavailable.
3. Leave **Add your apps** and **Advanced settings** at their defaults for a
   first try. App choices are request lists; they are not yet applied to
   the live image or installed system.
4. Under **Check your image**, click **Check image & continue** to inspect the
   selection. This does not start an ISO download. Read the status and open
   **Technical details** for the log.

Image availability does not prove browser qualification. At the
source revision checked for this guide, the catalog has no qualified browser
targets. **Build ISO** stays disabled for those targets. If you see **Browser
build unavailable: …**, read the reason. **Build locally with tacklebox**
offers **Download build-request.json** to export the selected build request
for local use. This downloads a JSON request.

See [browser qualification](QUALIFICATION.md) for the evidence still required;
neither inspection nor saving an ISO proves that it boots or installs.

## Build and save when enabled

When the status says **Image inspected — ready to build.** and **Build ISO**
is enabled, click **Build ISO**. If you change the selection, check it again
before you build. Keep the page open until the build and save finish.

- **Direct file saving:** The browser uses the `File System Access API`
  (`showSaveFilePicker`) when available. Choose a folder and `.iso` filename
  in the save dialog. The app streams chunks of the ISO to that file.
  If you cancel this initial dialog, the build stops.
- **Browser download fallback:** Without direct file saving, the app spools
  the ISO into the browser's private storage (OPFS). It then starts a download.
  Follow your browser's download prompt or settings to save it.
  The warning says this needs free disk space for **two copies**. Check the
  browser's downloads to confirm completion. The page cannot confirm that
  the download reached disk.

The warning recommends a Chromium-based browser such as Chrome, Edge or Brave.
Browser storage quota and free space in the destination folder are separate
limits. The app warns when the browser reports less than 9.5 GB free and blocks
below 4 GB. These thresholds do not guarantee an edition will fit. Cached
layers also use browser storage. When no operation is active, you can remove
them under **Advanced settings → Manage downloaded files → Clear downloaded
layers**; a later build must download them again.

The current fallback stores the ISO on disk. It does not buffer the whole ISO
in memory. The WASM engine still has a roughly 4 GiB memory ceiling, even with
direct saving. A build can fail in either save mode.

After **ISO build complete**, confirm that you have the `.iso` file on disk.
The page then shows options to write it to a USB drive.
This guide does not write or select a USB device.

Back up the USB drive and check the target before you write media.
The drive must have more space than the ISO file.
With normal installation, [Ventoy](https://www.ventoy.net/en/doc_start.html)
formats the selected drive and erases its data.

If Ventoy is already installed, copy the ISO to its data partition; do not
reinstall Ventoy to add a file.
Check that the partition has enough free space.
Follow the selected edition's official media instructions.

## Report a failure

[Open an iso-builder issue](https://github.com/tuna-os/iso-builder/issues/new)
with your browser name and version, operating system, selected desktop/base/
edition and target architecture, and the steps that failed. Include the exact
status/error and relevant **Technical details** log lines. Say whether you
used the save dialog or browser download, whether the download completed, and
any reported storage quota or memory warning. Review logs and screenshots
before you post them; remove tokens, credentials, private URLs and personal paths.

## Guide validation

We compared control labels and save/storage behavior with
[`index.html`](../app/public/index.html), [`app.js`](../app/public/app.js),
[`guided-picker.js`](../app/public/guided-picker.js) and
[`builder-config.json`](../app/public/builder-config.json) at `d2521c7`.
We checked relative links. We did not run a full ISO build, USB write or
installation to validate this guide.

### Interpreting output delivery

`ISO saved` means the writer closed the file without an error.
`Download started` means the browser accepted a download request.
The page cannot confirm that the download finished or that the file persists.
Check the download list in your browser before you write media.

If a user cancels a save, or a write fails, the page must hide the installation card.
Neither message proves a checksum match, publisher identity, or a successful installation.

The page must show unknown quota as unknown.
App choices are requests; the engine does not apply them to the system.

### Starting point and review

The first screen uses the recommendation in the deployment configuration.
It never selects the first catalog entry as a substitute.
Qualification remains separate. The page does not replace unavailable targets.

Use `Help me choose / browse all setups` to open catalog choices.
The base-first and desktop-first paths use the same catalog.
Check the architecture of the installation target, not the browser host.

Before you create media, review the target, temporary storage needs, and limits for app requests.
Back or Escape keeps the form unchanged.
On phones, use the setup link to move supported choices to a desktop.
The link does not use cloud storage.

This stage does not restore unsaved changes after refresh.
It does not import TOML setups.

The guidance for USB writers depends on the experience.
The Bluefin preview links to its official
[installation runbook](https://docs.projectbluefin.io/installation/).
On 2026-11-02, that guide recommended `Fedora Media Writer` and did not support `Ventoy`.
Use that guide for upstream media. This preview cannot create an installable Bluefin ISO.

### Recovering a plan after refresh

Use `Save planning choices for a refresh` to save a plan in this tab's session storage.
You must select the restore action explicitly.
The action checks the version, experience, catalog identity, selected leaf and each filter against the current catalog.
It keeps only catalog choices, app requests, package names and an uppercase ISO label.

The restore action does not restore build readiness, receipts or notice acknowledgements.
Advanced images, commands and overrides for boot or connections prevent a save or restore.
The action does not silently drop these values.
Use `Forget saved plan` to clear stored data. It does not clear the current form.

If storage fails, the form stays unchanged.
This temporary UI state is not a separate configuration source or a portable TOML format.
