// tacklebox-app is the native, cross-platform companion to the browser ISO
// builder (../app): instead of building a downloadable ISO in-browser, it
// writes a persistent, updatable multi-boot drive directly to a USB stick,
// using the real tacklebox binary — the actual differentiator over a
// plain ISO burner (see tuna-os/iso-builder#3).
//
// This is the Linux-native slice (tuna-os/iso-builder#1): it shells out to
// a `tacklebox` binary that must be on PATH or next to this executable.
// Windows/macOS need tuna-os/tacklebox#107/#108's VM-backed write paths
// before this can build on those platforms — see those issues for why.
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
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

var curatedImages = []curatedImage{
	{"Bluefin (GNOME)", "ghcr.io/ublue-os/bluefin:latest"},
	{"Bazzite (KDE)", "ghcr.io/ublue-os/bazzite:latest"},
	{"Aurora (KDE)", "ghcr.io/ublue-os/aurora:latest"},
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

// tackleboxPath resolves the tacklebox binary: next to this executable
// first (bundled distribution), falling back to PATH (dev/CI use).
func tackleboxPath() string {
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "tacklebox")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "tacklebox"
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
// temp recipe for img, run `tacklebox <subcommand> --yes <recipe> <drive>`,
// and stream its output into log line by line. All UI updates go through
// fyne.Do since this runs on a background goroutine — Fyne is not safe to
// touch from anywhere else (see the fyne.Do threading-model warning this
// code used to trigger before that was fixed).
func runRecipeCommand(subcommand, verb string, img curatedImage, drive Drive, log *widget.Entry, status *widget.Label, done func()) {
	recipe, err := writeTempRecipe(img)
	if err != nil {
		fyne.Do(func() { status.SetText("Failed to prepare recipe: " + err.Error()) })
		fyne.Do(done)
		return
	}
	defer os.Remove(recipe)

	cmd := exec.Command("sudo", tackleboxPath(), subcommand, "--yes", recipe, drive.Path)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fyne.Do(func() { status.SetText("Failed to start " + subcommand + ": " + err.Error()) })
		fyne.Do(done)
		return
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		fyne.Do(func() { status.SetText("Failed to start " + subcommand + ": " + err.Error()) })
		fyne.Do(done)
		return
	}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		fyne.Do(func() { log.SetText(log.Text + line + "\n") })
	}

	if err := cmd.Wait(); err != nil {
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
