# Browser quickstart

Open [ISO Builder](https://iso.tunaos.org) to choose an image and check whether
you can build it in your browser. The build runs on your computer and saves an
ISO file. You must then write that file to a USB drive to make it bootable.

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
