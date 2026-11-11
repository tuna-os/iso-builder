package drives

import (
	"encoding/json"
	"fmt"
	"strings"
)

// No build constraint on purpose: the safety decision is unit-tested on
// every runner. Ported from native/blockdev_windows.go.

// win32DiskDrive mirrors the WMI/CIM fields the safety filter needs from
// `Get-CimInstance Win32_DiskDrive`.
type win32DiskDrive struct {
	DeviceID      string // e.g. \\.\PHYSICALDRIVE2
	Model         string
	Size          int64
	InterfaceType string // "USB", "SCSI", "IDE", ...
	MediaType     string // "Removable Media", "Fixed hard disk media", ...
	Index         int
	SerialNumber  string
}

// win32Script enumerates physical disks. -Depth/explicit properties because
// Win32_DiskDrive's default ConvertTo-Json output recurses through circular
// CIM association properties.
const win32Script = `Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,Size,InterfaceType,MediaType,Index,SerialNumber | ConvertTo-Json`

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
// removable media, and size must be non-zero. excluded holds disk numbers
// that must never be offered (the system disk, the ISO's disk).
func filterSafeDrivesWindows(drives []win32DiskDrive, excluded map[int]bool) []Drive {
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
		if excluded[d.Index] {
			continue
		}
		ident := strings.TrimSpace(d.SerialNumber)
		if ident == "" {
			ident = strings.TrimSpace(d.Model)
		}
		safe = append(safe, Drive{
			Path:       d.DeviceID,
			Name:       strings.TrimSpace(d.Model),
			SizeBytes:  d.Size,
			Bus:        "usb",
			Removable:  true,
			Ident:      ident,
			DiskNumber: d.Index,
		})
	}
	return safe
}
