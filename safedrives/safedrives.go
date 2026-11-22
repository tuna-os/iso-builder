// Package safedrives is the single home of the Media Writer and native
// writer write-target safety filters (tuna-os/iso-builder#620).
//
// Both apps decide which disks a user may overwrite. That decision used to
// live in two copies — native/blockdev_linux.go + blockdev_windows.go (the
// older Fyne writer, package main) and desktop/helper/internal/drives (the
// Media Writer helper) — and the copies forked: only the helper excluded
// the system disk and the disk holding the ISO. Each app now keeps only its
// own enumeration (lsblk vs. sysfs/mountinfo, PowerShell) and maps the
// result to its own Drive type; the accept/reject decision lives here and
// is unit-tested here on fixtures from both suites.
package safedrives

// Drive is one accepted write-target candidate. Each app maps it to its
// own Drive type.
type Drive struct {
	Path      string
	Name      string
	SizeBytes int64
	// Bus is "usb", "sd" or "other" (Linux). Windows only lists USB.
	Bus       string
	Removable bool
	Mounted   []string
	// Ident is the disk serial when the OS reports one, else its model.
	Ident string
	// DiskNumber is the Windows physical disk number; 0 on other platforms.
	DiskNumber int
}
