package main

import "fmt"

// PrerequisiteError signals a missing external dependency (WSL2 on
// Windows, QEMU on macOS, ...) that the app can potentially resolve for
// the user automatically, rather than just telling them to run a command
// themselves — the whole audience this app targets is people who don't
// know what a command line is (tuna-os/iso-builder#1's whole premise).
// The UI layer (main.go) detects this via errors.As and offers a "Fix"
// button wired to Fix, instead of a dead-end error dialog.
type PrerequisiteError struct {
	// Message explains what's missing, in plain language suitable for
	// showing directly in a dialog.
	Message string
	// FixLabel is the button text offered to the user, e.g. "Install WSL2".
	FixLabel string
	// Fix attempts to resolve the problem automatically. onLine receives
	// progress output for streaming into the log pane. Returns an error if
	// the fix itself failed, or if manual follow-up (like a reboot) is
	// still required — that error's message should explain the follow-up
	// clearly, since the user is the one who has to act on it.
	Fix func(onLine func(string)) error
}

func (e *PrerequisiteError) Error() string { return e.Message }

// Drive is a candidate write target, already filtered to what's safe to
// offer a non-technical user. Platform-neutral — populated by
// blockdev_linux.go or blockdev_darwin.go depending on GOOS.
type Drive struct {
	Path  string // e.g. /dev/sda or /dev/disk4
	Model string
	SizeH string // human-readable size, e.g. "32G"
	Size  int64  // bytes
}

// selectionIsCurrent prevents a slow status probe for one disk from changing
// the action state of a disk selected immediately afterwards.
func selectionIsCurrent(expectedPath, currentPath string, expectedEpoch, currentEpoch uint64) bool {
	return expectedPath != "" && expectedPath == currentPath && expectedEpoch == currentEpoch
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
