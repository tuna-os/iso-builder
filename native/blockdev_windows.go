package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// win32DiskDrive mirrors the WMI/CIM fields the safety filter needs from
// `Get-CimInstance Win32_DiskDrive`.
type win32DiskDrive struct {
	DeviceID      string // e.g. \\.\PHYSICALDRIVE2
	Model         string
	Size          int64
	InterfaceType string // "USB", "SCSI", "IDE", ...
	MediaType     string // "Removable Media", "Fixed hard disk media", ...
	Index         int
}

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
	script := `Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,Size,InterfaceType,MediaType,Index | ConvertTo-Json`
	out, err := exec.Command("powershell", "-NoProfile", "-Command", script).Output()
	if err != nil {
		return nil, fmt.Errorf("Get-CimInstance Win32_DiskDrive: %w", err)
	}

	drives, err := parseWin32DiskDrives(out)
	if err != nil {
		return nil, err
	}
	return filterSafeDrivesWindows(drives), nil
}

// parseWin32DiskDrives handles PowerShell's ConvertTo-Json quirk: a single
// matching object serializes as a bare JSON object, not a one-element
// array, so callers can't just json.Unmarshal into []win32DiskDrive
// unconditionally.
func parseWin32DiskDrives(data []byte) ([]win32DiskDrive, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var drives []win32DiskDrive
		if err := json.Unmarshal(data, &drives); err != nil {
			return nil, fmt.Errorf("parse Win32_DiskDrive JSON array: %w", err)
		}
		return drives, nil
	}
	var one win32DiskDrive
	if err := json.Unmarshal(data, &one); err != nil {
		return nil, fmt.Errorf("parse Win32_DiskDrive JSON object: %w", err)
	}
	return []win32DiskDrive{one}, nil
}

// filterSafeDrivesWindows is the pure safety filter: InterfaceType must be
// "USB" (excludes the internal SCSI/NVMe/IDE system disk categorically,
// not just by heuristics about mount points — the same defense-in-depth
// rpi-imager uses per tuna-os/tacklebox#106), MediaType must indicate
// removable media, and size must be non-zero.
func filterSafeDrivesWindows(drives []win32DiskDrive) []Drive {
	var safe []Drive
	for _, d := range drives {
		if !strings.EqualFold(d.InterfaceType, "USB") {
			continue
		}
		if !strings.Contains(strings.ToLower(d.MediaType), "removable") {
			continue
		}
		if d.Size <= 0 {
			continue
		}
		safe = append(safe, Drive{
			Path:  d.DeviceID,
			Model: strings.TrimSpace(d.Model),
			Size:  d.Size,
			SizeH: humanSize(d.Size),
		})
	}
	return safe
}
