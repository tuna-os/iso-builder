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
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

func main() {
	a := app.NewWithID("org.tunaos.tacklebox-app")
	a.Settings().SetTheme(adwaitaTheme{}) // GNOME/Adwaita look + readable log
	w := a.NewWindow("TunaOS ISO Builder")
	w.Resize(fyne.NewSize(560, 640))

	status := widget.NewLabel("")
	status.Wrapping = fyne.TextWrapWord

	// imageList replaces a plain text dropdown with a real card per
	// entry — logo, name, and a short description — so a catalog
	// spanning multiple projects (TunaOS's own images, plus curated
	// entries from Project Bluefin/Universal Blue/Zirconium — see
	// catalog.go) reads as "which OS is this" rather than an
	// undifferentiated wall of similar-looking names. widget.Select
	// has no way to render more than plain text per row, hence the
	// switch to widget.List with a custom item template.
	// visible is the currently-shown subset of curatedImages (all of it until
	// the user types in the search box). The list, selection and the build/
	// update actions all index into visible, never curatedImages directly.
	selectedImageIdx := -1
	visible := make([]curatedImage, len(curatedImages))
	copy(visible, curatedImages)

	imageList := widget.NewList(
		func() int { return len(visible) },
		func() fyne.CanvasObject {
			icon := canvas.NewImageFromResource(nil)
			icon.FillMode = canvas.ImageFillContain
			icon.SetMinSize(fyne.NewSize(32, 32))
			name := widget.NewLabelWithStyle("", fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
			sub := widget.NewLabel("")
			sub.Wrapping = fyne.TextWrapWord
			sub.TextStyle = fyne.TextStyle{Italic: true}
			return container.NewBorder(nil, nil, icon, nil,
				container.NewVBox(name, sub))
		},
		func(id widget.ListItemID, obj fyne.CanvasObject) {
			img := visible[id]
			row := obj.(*fyne.Container)
			icon := row.Objects[1].(*canvas.Image)
			icon.Resource = catalogLogo(img.LogoAsset)
			icon.Refresh()
			text := row.Objects[0].(*fyne.Container)
			name := text.Objects[0].(*widget.Label)
			sub := text.Objects[1].(*widget.Label)
			name.SetText(img.Name)
			sub.SetText(img.Org + " — " + img.Description)
		},
	)
	imageList.OnSelected = func(id widget.ListItemID) { selectedImageIdx = id }
	imageList.OnUnselected = func(widget.ListItemID) { selectedImageIdx = -1 }
	imageListScroll := container.NewScroll(imageList)
	imageListScroll.SetMinSize(fyne.NewSize(540, 220))

	// searchEntry filters the (long) catalog by name, project or description —
	// the list spans every variant×desktop plus curated external images, too
	// many to scroll comfortably.
	searchEntry := widget.NewEntry()
	searchEntry.PlaceHolder = "Search images by name, project, or description…"
	searchEntry.OnChanged = func(q string) {
		q = strings.ToLower(strings.TrimSpace(q))
		visible = visible[:0]
		for _, img := range curatedImages {
			if q == "" ||
				strings.Contains(strings.ToLower(img.Name), q) ||
				strings.Contains(strings.ToLower(img.Org), q) ||
				strings.Contains(strings.ToLower(img.Description), q) {
				visible = append(visible, img)
			}
		}
		selectedImageIdx = -1
		imageList.UnselectAll()
		imageList.Refresh()
		imageList.ScrollToTop()
	}
	searchBox := container.NewBorder(nil, nil, widget.NewIcon(theme.SearchIcon()), nil, searchEntry)

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
	log.TextStyle = fyne.TextStyle{Monospace: true} // terminal feel (Adwaita Mono via theme)
	log.Disable()                                   // read-only; theme gives it a legible colour
	logScroll := container.NewScroll(log)
	logScroll.SetMinSize(fyne.NewSize(540, 200))

	// busyGuard disables every button that mutates or reads a drive while
	// an operation is running, shows the progress bar, and returns a
	// "done" callback that undoes both — shared by every action below
	// (build/add/verify/update/remove) so there's exactly one place that
	// decides what "an operation is in flight" means for the UI, and a
	// user can't e.g. click Update while a build is still running.
	// allActionButtons is populated once every button exists (Go closures
	// capture variables by reference, not value, so busyGuard reads
	// whatever allActionButtons holds at call time — safe here because
	// nothing invokes busyGuard until the event loop starts, well after
	// main() finishes populating it below).
	var allActionButtons []*widget.Button
	busyGuard := func() func() {
		for _, b := range allActionButtons {
			b.Disable()
		}
		progress.Show()
		log.SetText("")
		return func() {
			for _, b := range allActionButtons {
				b.Enable()
			}
			progress.Hide()
		}
	}

	// bootCheckBox offers an optional post-write boot verification (see
	// bootcheck_linux.go — tuna-os/tacklebox#104's "Milestone 5"). Only
	// shown where it's actually supported: the macOS/Windows write paths
	// already run inside a VM/WSL2, so nesting a second boot check there
	// isn't attempted (see bootcheck_darwin.go/bootcheck_windows.go).
	bootCheckBox := widget.NewCheck("Verify by booting in a VM after writing (slower)", nil)
	if !bootCheckSupported() {
		bootCheckBox.Hide()
	}

	var buildBtn *widget.Button
	buildBtn = widget.NewButton("Write to drive", func() {
		imgIdx := selectedImageIdx
		drvIdx := driveSelect.SelectedIndex()
		if imgIdx < 0 || imgIdx >= len(visible) || drvIdx < 0 {
			dialog.ShowInformation("Missing selection", "Choose both an OS and a drive first.", w)
			return
		}
		drive := drives[drvIdx]
		img := visible[imgIdx]
		verifyBoot := bootCheckBox.Checked

		start := func() {
			done := busyGuard()
			if managed {
				go runAdd(img, drive, verifyBoot, log, status, w, done)
			} else {
				go runBuild(img, drive, verifyBoot, log, status, w, done)
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

	verifyBtn := widget.NewButton("Verify", func() {
		drvIdx := driveSelect.SelectedIndex()
		if drvIdx < 0 {
			return
		}
		drive := drives[drvIdx]
		done := busyGuard()
		go runVerify(drive, log, status, w, done)
	})

	updateBtn := widget.NewButton("Update", func() {
		imgIdx, drvIdx := selectedImageIdx, driveSelect.SelectedIndex()
		if imgIdx < 0 || imgIdx >= len(visible) || drvIdx < 0 {
			dialog.ShowInformation("Missing selection", "Choose an OS above first — Update re-installs it in place.", w)
			return
		}
		drive, img := drives[drvIdx], visible[imgIdx]
		done := busyGuard()
		go runUpdate(img, drive, bootCheckBox.Checked, log, status, w, done)
	})

	removeEnvEntry := widget.NewEntry()
	removeEnvEntry.PlaceHolder = "environment id (see Verify/status output above)"
	removeBtn := widget.NewButton("Remove", func() {
		drvIdx := driveSelect.SelectedIndex()
		envID := removeEnvEntry.Text
		if drvIdx < 0 || envID == "" {
			dialog.ShowInformation("Missing environment id", "Type the environment id to remove (shown in the drive status above).", w)
			return
		}
		drive := drives[drvIdx]
		dialog.ShowConfirm(
			"Remove "+envID+"?",
			fmt.Sprintf("This removes %s from %s and reclaims its space. Other environments on the drive are untouched.", envID, drive.Path),
			func(confirmed bool) {
				if !confirmed {
					return
				}
				done := busyGuard()
				go runRemove(envID, drive, log, status, w, done)
			},
			w,
		)
	})

	allActionButtons = []*widget.Button{buildBtn, refreshBtn, verifyBtn, updateBtn, removeBtn}
	managePanel := container.NewVBox(
		widget.NewLabelWithStyle("Manage this drive", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		container.NewHBox(verifyBtn, updateBtn),
		container.NewBorder(nil, nil, nil, removeBtn, removeEnvEntry),
	)
	managePanel.Hide() // shown only once a managed drive is detected, see OnChanged below

	driveSelect.OnChanged = func(string) {
		drvIdx := driveSelect.SelectedIndex()
		if drvIdx < 0 || drvIdx >= len(drives) {
			return
		}
		drive := drives[drvIdx]
		driveInfo.SetText("Checking " + drive.Path + "…")
		buildBtn.SetText("Write to drive")
		managePanel.Hide()
		go func() {
			isManaged, out := isManagedDrive(drive.Path)
			fyne.Do(func() {
				managed = isManaged
				if isManaged {
					driveInfo.SetText("Already has TunaOS on it:\n" + out)
					buildBtn.SetText("Add to drive")
					managePanel.Show()
				} else {
					driveInfo.SetText("Blank drive — writing will erase everything on it.")
					buildBtn.SetText("Write to drive")
				}
			})
		}()
	}

	// viewVMBtn is a debugging escape hatch (tuna-os/iso-builder#12):
	// macOS's write path boots a headless VM, and if something goes
	// wrong inside it in a way that doesn't come through cleanly as an
	// SSH-streamed log line, there was previously no way to just look
	// at what the VM was doing. Deliberately NOT added to
	// allActionButtons — busyGuard disables those during an operation,
	// but this button is meant to be clicked WHILE one is in progress
	// (that's the only time a VM exists to view). Hidden entirely on
	// platforms with nothing to view.
	viewVMBtn := widget.NewButton("View VM console (debug)", func() {
		if err := openVMViewer(); err != nil {
			dialog.ShowError(err, w)
		}
	})
	if !vmViewerSupported() {
		viewVMBtn.Hide()
	}

	content := container.NewVBox(
		widget.NewLabelWithStyle("1. Choose an OS", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		searchBox,
		imageListScroll,
		widget.NewLabelWithStyle("2. Choose a drive", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		container.NewBorder(nil, nil, nil, refreshBtn, driveSelect),
		driveInfo,
		bootCheckBox,
		buildBtn,
		viewVMBtn,
		managePanel,
		progress,
		status,
		widget.NewLabelWithStyle("Log", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		logScroll,
	)
	w.SetContent(content)

	refreshDrives()
	w.ShowAndRun()
}

// handlePrerequisiteError checks whether err is a *PrerequisiteError (a
// missing dependency this app knows how to fix, e.g. WSL2 or QEMU — see
// drive.go) and, if so, offers the user a one-click fix instead of a
// dead-end error message. Returns true if it handled err (caller should
// not also show a generic failure), false otherwise.
func handlePrerequisiteError(err error, log *widget.Entry, status *widget.Label, w fyne.Window) bool {
	var prereq *PrerequisiteError
	if !errors.As(err, &prereq) {
		return false
	}
	fyne.Do(func() {
		status.SetText(prereq.Message)
		dialog.ShowConfirm("Something's missing", prereq.Message+"\n\nClick \""+prereq.FixLabel+"\" to try fixing it automatically.", func(confirmed bool) {
			if !confirmed {
				return
			}
			go func() {
				onLine := func(line string) { fyne.Do(func() { log.SetText(log.Text + line + "\n") }) }
				fixErr := prereq.Fix(onLine)
				fyne.Do(func() {
					if fixErr != nil {
						status.SetText(fixErr.Error())
					} else {
						status.SetText("Fixed — try again.")
					}
				})
			}()
		}, w)
	})
	return true
}

// runBuild writes a single-env recipe for img directly to drive.Path via
// `tacklebox build --yes`, erasing whatever was there before. Use runAdd
// instead for an already-managed drive (tuna-os/iso-builder#3).
func runBuild(img curatedImage, drive Drive, verifyBoot bool, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
	runRecipeCommand("build", "Build", img, drive, verifyBoot, log, status, w, done)
}

// runAdd installs img onto drive.Path alongside whatever's already there,
// via `tacklebox add --yes` — no reformatting. This is the actual
// differentiator over a one-shot ISO burner (tuna-os/iso-builder#3): a
// drive tacklebox manages can grow instead of being replaced.
func runAdd(img curatedImage, drive Drive, verifyBoot bool, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
	runRecipeCommand("add", "Add", img, drive, verifyBoot, log, status, w, done)
}

// runUpdate re-installs img on drive.Path in place, via `tacklebox update
// --yes` — refreshes an already-installed environment to match the
// current image, rotating BLS entries and extracting new kernels/initrd
// as needed (tuna-os/iso-builder#2).
func runUpdate(img curatedImage, drive Drive, verifyBoot bool, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
	runRecipeCommand("update", "Update", img, drive, verifyBoot, log, status, w, done)
}

// runRecipeCommand is the shared plumbing behind runBuild/runAdd/runUpdate:
// write a temp recipe for img and hand off to executeTacklebox — the
// actual platform-specific execution (exec_linux.go runs tacklebox
// directly; exec_darwin.go/exec_windows.go have to reach a real Linux
// environment first, see those files' doc comments for why). All UI
// updates go through fyne.Do since this runs on a background goroutine —
// Fyne is not safe to touch from anywhere else (see the fyne.Do
// threading-model warning this code used to trigger before that was
// fixed).
//
// verifyBoot, when true and bootCheckSupported() (only Linux for now —
// see bootcheck_linux.go), boots the just-written drive in a throwaway
// QEMU VM after a successful write and confirms it actually reaches
// userspace, rather than trusting that "tacklebox exited 0" is the whole
// story.
func runRecipeCommand(subcommand, verb string, img curatedImage, drive Drive, verifyBoot bool, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
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
		if !handlePrerequisiteError(err, log, status, w) {
			fyne.Do(func() { status.SetText(verb + " failed: " + err.Error()) })
		}
		fyne.Do(done)
		return
	}

	if verifyBoot {
		fyne.Do(func() { status.SetText("Verifying by booting " + drive.Path + " in a VM...") })
		if err := runBootCheck(drive.Path, onLine); err != nil {
			if !handlePrerequisiteError(err, log, status, w) {
				fyne.Do(func() { status.SetText(verb + " succeeded, but the boot check failed: " + err.Error()) })
			}
			fyne.Do(done)
			return
		}
		fyne.Do(func() { status.SetText("Done — " + drive.Path + " is ready and confirmed bootable.") })
	} else {
		fyne.Do(func() { status.SetText("Done — " + drive.Path + " is ready.") })
	}
	fyne.Do(done)
}

// runVerify checks a drive's integrity via `tacklebox verify` — no recipe
// involved, so it goes through runTackleboxArgs rather than
// runRecipeCommand (tuna-os/iso-builder#2).
func runVerify(drive Drive, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
	onLine := func(line string) {
		fyne.Do(func() { log.SetText(log.Text + line + "\n") })
	}
	err := runTackleboxArgs(drive.Path, func(device string) []string {
		return []string{"verify", device}
	}, onLine)
	if err != nil {
		if !handlePrerequisiteError(err, log, status, w) {
			fyne.Do(func() { status.SetText("Verify failed: " + err.Error()) })
		}
	} else {
		fyne.Do(func() { status.SetText(drive.Path + " passed verification.") })
	}
	fyne.Do(done)
}

// runRemove removes envID from drive.Path via `tacklebox remove --yes`,
// reclaiming its space without touching the rest of the drive
// (tuna-os/iso-builder#2 — the actual "manage a persistent drive" lifecycle,
// not just build/add).
func runRemove(envID string, drive Drive, log *widget.Entry, status *widget.Label, w fyne.Window, done func()) {
	onLine := func(line string) {
		fyne.Do(func() { log.SetText(log.Text + line + "\n") })
	}
	err := runTackleboxArgs(drive.Path, func(device string) []string {
		return []string{"remove", envID, device, "--yes"}
	}, onLine)
	if err != nil {
		if !handlePrerequisiteError(err, log, status, w) {
			fyne.Do(func() { status.SetText("Remove failed: " + err.Error()) })
		}
	} else {
		fyne.Do(func() { status.SetText("Removed " + envID + " from " + drive.Path + ".") })
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
