package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/tuna-os/iso-builder/safedrives"
)

// win32DiskDrive mirrors the WMI/CIM fields the safety filter needs from
// `Get-CimInstance Win32_DiskDrive`. It is the shared safedrives input.
type win32DiskDrive = safedrives.WinDisk

// SafeWriteTargets enumerates physical disks via PowerShell/CIM and returns
// only the ones filterSafeDrivesWindows accepts. As with the Linux and
// macOS packages, the live PowerShell call and the actual filter decision
// are kept separate (filterSafeDrivesWindows takes plain data, no
// PowerShell involved) so the safety-critical logic is unit-testable
// without a live device or admin rights — same split tuna-os/tacklebox#106
// and #109 require of the darwin package this mirrors.
func SafeWriteTargets() ([]Drive, error) {
	// -Depth 3 and explicit property selection because Win32_DiskDrive's
	// default ConvertTo-Json output includes circular CIM association
	// properties that recurse forever without it.
	script := `Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,Size,InterfaceType,MediaType,Index,SerialNumber | ConvertTo-Json`
	out, err := exec.Command("powershell", "-NoProfile", "-Command", script).Output()
	if err != nil {
		return nil, fmt.Errorf("Get-CimInstance Win32_DiskDrive: %w", err)
	}

	drives, err := parseWin32DiskDrives(out)
	if err != nil {
		return nil, err
	}
	// A USB disk holding the running system passes the USB/removable
	// check, so the system disk is excluded by number as well. Fail
	// closed when the system disk cannot be located.
	excluded := map[int]bool{}
	sys, err := systemDiskNumber()
	if err != nil {
		return nil, err
	}
	excluded[sys] = true
	return filterSafeDrivesWindows(drives, excluded), nil
}

// systemDiskNumber returns the physical disk holding the Windows system
// drive (usually C:).
func systemDiskNumber() (int, error) {
	letter := os.Getenv("SystemDrive")
	letter = strings.TrimRight(strings.TrimSpace(letter), `:\`)
	if letter == "" {
		letter = "C"
	}
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`(Get-Partition -DriveLetter `+letter+`).DiskNumber`).Output()
	if err != nil {
		return 0, fmt.Errorf("locate system disk: %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("locate system disk: %w", err)
	}
	return n, nil
}

// parseWin32DiskDrives handles PowerShell's ConvertTo-Json quirk; see
// safedrives.ParseWin32DiskDrives.
func parseWin32DiskDrives(data []byte) ([]win32DiskDrive, error) {
	return safedrives.ParseWin32DiskDrives(data)
}

// filterSafeDrivesWindows maps the shared decision to the native Drive
// type. excluded holds disk numbers that must never be offered (the system
// disk, the ISO's disk).
func filterSafeDrivesWindows(drives []win32DiskDrive, excluded map[int]bool) []Drive {
	var safe []Drive
	for _, c := range safedrives.FilterWindows(drives, excluded) {
		safe = append(safe, Drive{
			Path:  c.Path,
			Model: c.Name,
			Size:  c.SizeBytes,
			SizeH: humanSize(c.SizeBytes),
		})
	}
	return safe
}
