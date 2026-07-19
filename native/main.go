// tacklebox-app is the native, cross-platform companion to the browser ISO
// builder (../app): instead of building a downloadable ISO in-browser, it
// writes a persistent, updatable multi-boot drive directly to a USB stick,
// using the real tacklebox binary — the actual differentiator over a
// plain ISO burner (see tuna-os/iso-builder#3).
//
// Execution is platform-specific (executeTacklebox, implemented in
// exec_linux.go/exec_darwin.go/exec_windows.go): Linux runs tacklebox
// directly, since it already has the real Linux kernel bootc install
// needs; macOS and Windows both boot/attach a real Linux environment
// first (a bundled QEMU VM on macOS, WSL2 on Windows) and run the same
// tacklebox flow inside it — see tuna-os/tacklebox#106/#107/#108 for why
// that's necessary rather than a native reimplementation.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

// curatedImage is one entry in the hand-picked image list. This mirrors the
// browser app's edition picker (../app/public) rather than exposing raw
// recipe JSON — see tuna-os/iso-builder#3's Guided/Advanced split.
type curatedImage struct {
	Name  string
	Image string // <repo>:<tag>
}

// desktopName maps a desktop ID to its display name — copied from
// ../app/public/app.js's DESKTOPS map (source of truth; keep in sync by
// hand, there are only 5). Deliberately dropping app.js's emoji: this is a
// native desktop app, not a web picker skinned to match the browser one.
var desktopName = map[string]string{
	"gnome":  "GNOME",
	"kde":    "KDE Plasma",
	"cosmic": "COSMIC",
	"niri":   "Niri",
	"xfce":   "XFCE",
}

// variant is one base OS in the image matrix, copied from
// ../app/public/app.js's VARIANTS array — real tuna-os image IDs
// (fish-themed codenames, not a coincidence). Community desktops
// (kde/cosmic/niri/xfce) aren't published as ISOs there either, so this
// app is one of the only ways to get them, same as the browser picker.
type variant struct {
	id       string
	name     string
	desktops []string
}

var variants = []variant{
	{"yellowfin", "AlmaLinux Kitten 10 (flagship)", []string{"gnome", "kde", "cosmic", "niri"}},
	{"bonito", "Fedora 44", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"sailfin", "openSUSE Tumbleweed", []string{"gnome", "kde", "niri", "xfce"}},
	{"flounder", "Debian 13 Trixie", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"grouper", "Ubuntu 26.04", []string{"gnome", "kde", "niri", "xfce"}},
	{"marlin", "Arch Linux", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"skipjack", "CentOS Stream 10", []string{"gnome", "kde", "cosmic", "niri"}},
	{"albacore", "AlmaLinux 10", []string{"gnome", "kde", "cosmic", "niri"}},
	{"guppy", "Gentoo (source-based)", []string{"gnome", "kde"}},
}

// curatedImages is the full variant×desktop matrix, generated from
// variants/desktopName rather than hand-typed — the fabricated-image-list
// bug this replaced happened specifically because a hand-typed list wasn't
// checked against the source of truth (app.js) until after the fact.
// Generating it from the same structured data app.js itself iterates over
// makes that class of bug structurally harder to reintroduce.
var curatedImages = buildCuratedImages()

func buildCuratedImages() []curatedImage {
	var out []curatedImage
	for _, v := range variants {
		for _, de := range v.desktops {
			name := desktopName[de]
			if name == "" {
				name = de
			}
			out = append(out, curatedImage{
				Name:  v.name + " — " + name,
				Image: fmt.Sprintf("ghcr.io/tuna-os/%s:%s", v.id, de),
			})
		}
	}
	return out
}

func main() {
	a := app.NewWithID("org.tunaos.tacklebox-app")
	w := a.NewWindow("TunaOS ISO Builder")
	w.Resize(fyne.NewSize(560, 420))

	status := widget.NewLabel("")
	status.Wrapping = fyne.TextWrapWord

	imageNames := make([]string, len(curatedImages))
	for i, img := range curatedImages {
		imageNames[i] = img.Name
	}
	imageSelect := widget.NewSelect(imageNames, func(string) {})
	imageSelect.PlaceHolder = "Choose an OS"

	driveSelect := widget.NewSelect(nil, func(string) {})
	driveSelect.PlaceHolder = "Choose a drive"
	var drives []Drive

	driveInfo := widget.NewLabel("")
	driveInfo.Wrapping = fyne.TextWrapWord
	managed := false // whether the currently-selected drive is already tacklebox-managed

	refreshDrives := func() {
		found, err := SafeWriteTargets()
		if err != nil {
			status.SetText("Could not list drives: " + err.Error())
			return
		}
		drives = found
		names := make([]string, len(found))
		for i, d := range found {
			label := d.Path + "  —  " + d.SizeH
			if d.Model != "" {
				label = d.Path + "  —  " + d.Model + "  (" + d.SizeH + ")"
			}
			names[i] = label
		}
		driveSelect.Options = names
		driveSelect.Refresh()
		if len(found) == 0 {
			status.SetText("No safe drives found. Plug in a USB drive and click Refresh.")
		} else {
			status.SetText(fmt.Sprintf("%d drive(s) available.", len(found)))
		}
	}

	refreshBtn := widget.NewButton("Refresh drives", refreshDrives)

	progress := widget.NewProgressBarInfinite()
	progress.Hide()

	log := widget.NewMultiLineEntry()
	log.Disable()
	logScroll := container.NewScroll(log)
	logScroll.SetMinSize(fyne.NewSize(540, 200))

	var buildBtn *widget.Button
	buildBtn = widget.NewButton("Write to drive", func() {
		imgIdx := imageSelect.SelectedIndex()
		drvIdx := driveSelect.SelectedIndex()
		if imgIdx < 0 || drvIdx < 0 {
			dialog.ShowInformation("Missing selection", "Choose both an OS and a drive first.", w)
			return
		}
		drive := drives[drvIdx]
		img := curatedImages[imgIdx]

		start := func() {
			buildBtn.Disable()
			refreshBtn.Disable()
			progress.Show()
			log.SetText("")
			done := func() {
				buildBtn.Enable()
				refreshBtn.Enable()
				progress.Hide()
			}
			if managed {
				go runAdd(img, drive, log, status, done)
			} else {
				go runBuild(img, drive, log, status, done)
			}
		}

		// A blank/foreign drive needs the destructive "erase everything"
		// confirmation. An already-managed drive doesn't — adding an OS to
		// it is the whole point of tuna-os/iso-builder#3's default UX, and
		// asking "are you sure you want to erase" would be actively wrong.
		if managed {
			start()
			return
		}
		dialog.ShowConfirm(
			"This will ERASE "+drive.Path,
			fmt.Sprintf("Everything on %s (%s) will be permanently erased and replaced with %s.\n\nThis cannot be undone.",
				drive.Path, drive.SizeH, img.Name),
			func(confirmed bool) {
				if confirmed {
					start()
				}
			},
			w,
		)
	})

	driveSelect.OnChanged = func(string) {
		drvIdx := driveSelect.SelectedIndex()
		if drvIdx < 0 || drvIdx >= len(drives) {
			return
		}
		drive := drives[drvIdx]
		driveInfo.SetText("Checking " + drive.Path + "…")
		buildBtn.SetText("Write to drive")
		go func() {
			isManaged, out := isManagedDrive(drive.Path)
			fyne.Do(func() {
				managed = isManaged
				if isManaged {
					driveInfo.SetText("Already has TunaOS on it:\n" + out)
					buildBtn.SetText("Add to drive")
				} else {
					driveInfo.SetText("Blank drive — writing will erase everything on it.")
					buildBtn.SetText("Write to drive")
				}
			})
		}()
	}

	content := container.NewVBox(
		widget.NewLabelWithStyle("1. Choose an OS", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		imageSelect,
		widget.NewLabelWithStyle("2. Choose a drive", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		container.NewBorder(nil, nil, nil, refreshBtn, driveSelect),
		driveInfo,
		buildBtn,
		progress,
		status,
		widget.NewLabelWithStyle("Log", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		logScroll,
	)
	w.SetContent(content)

	refreshDrives()
	w.ShowAndRun()
}

// runBuild writes a single-env recipe for img directly to drive.Path via
// `tacklebox build --yes`, erasing whatever was there before. Use runAdd
// instead for an already-managed drive (tuna-os/iso-builder#3).
func runBuild(img curatedImage, drive Drive, log *widget.Entry, status *widget.Label, done func()) {
	runRecipeCommand("build", "Build", img, drive, log, status, done)
}

// runAdd installs img onto drive.Path alongside whatever's already there,
// via `tacklebox add --yes` — no reformatting. This is the actual
// differentiator over a one-shot ISO burner (tuna-os/iso-builder#3): a
// drive tacklebox manages can grow instead of being replaced.
func runAdd(img curatedImage, drive Drive, log *widget.Entry, status *widget.Label, done func()) {
	runRecipeCommand("add", "Add", img, drive, log, status, done)
}

// runRecipeCommand is the shared plumbing behind runBuild/runAdd: write a
// temp recipe for img and hand off to executeTacklebox — the actual
// platform-specific execution (blockdev_linux.go runs tacklebox directly;
// vmbuild_darwin.go has to boot a Linux VM first, see that file's doc
// comment for why). All UI updates go through fyne.Do since this runs on a
// background goroutine — Fyne is not safe to touch from anywhere else (see
// the fyne.Do threading-model warning this code used to trigger before
// that was fixed).
func runRecipeCommand(subcommand, verb string, img curatedImage, drive Drive, log *widget.Entry, status *widget.Label, done func()) {
	recipe, err := writeTempRecipe(img)
	if err != nil {
		fyne.Do(func() { status.SetText("Failed to prepare recipe: " + err.Error()) })
		fyne.Do(done)
		return
	}
	defer os.Remove(recipe)

	onLine := func(line string) {
		fyne.Do(func() { log.SetText(log.Text + line + "\n") })
	}

	if err := executeTacklebox(subcommand, recipe, drive.Path, onLine); err != nil {
		fyne.Do(func() { status.SetText(verb + " failed: " + err.Error()) })
	} else {
		fyne.Do(func() { status.SetText("Done — " + drive.Path + " is ready.") })
	}
	fyne.Do(done)
}

// writeTempRecipe writes a minimal single-env tacklebox recipe for img to a
// temp file and returns its path. Matches the shape of tacklebox's own
// fixtures (see tuna-os/tacklebox/fixtures/simple.json).
func writeTempRecipe(img curatedImage) (string, error) {
	f, err := os.CreateTemp("", "tacklebox-recipe-*.json")
	if err != nil {
		return "", err
	}
	defer f.Close()

	envID := filepath.Base(img.Image)
	recipe := fmt.Sprintf(`{
  "media_name": "TUNAOS",
  "size": "16G",
  "shared_store": {"format": "ext4"},
  "bootable_environments": [
    {"id": %q, "image": %q, "modes": ["live", "persistent"]}
  ]
}`, envID, img.Image)

	if _, err := f.WriteString(recipe); err != nil {
		return "", err
	}
	return f.Name(), nil
}
