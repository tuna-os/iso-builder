package safedrives

import (
	"encoding/json"
	"fmt"
	"strings"
)

// WinDisk mirrors the WMI/CIM fields the safety filter needs from
// `Get-CimInstance Win32_DiskDrive`.
type WinDisk struct {
	DeviceID      string // e.g. \\.\PHYSICALDRIVE2
	Model         string
	Size          int64
	InterfaceType string // "USB", "SCSI", "IDE", ...
	MediaType     string // "Removable Media", "Fixed hard disk media", ...
	Index         int
	SerialNumber  string
}

// ParseWin32DiskDrives handles PowerShell's ConvertTo-Json quirk: a single
// matching object serializes as a bare JSON object, not a one-element
// array, so callers can't just json.Unmarshal into []WinDisk
// unconditionally.
func ParseWin32DiskDrives(data []byte) ([]WinDisk, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var disks []WinDisk
		if err := json.Unmarshal(data, &disks); err != nil {
			return nil, fmt.Errorf("parse Win32_DiskDrive JSON array: %w", err)
		}
		return disks, nil
	}
	var one WinDisk
	if err := json.Unmarshal(data, &one); err != nil {
		return nil, fmt.Errorf("parse Win32_DiskDrive JSON object: %w", err)
	}
	return []WinDisk{one}, nil
}

// FilterWindows is the pure safety filter: InterfaceType must be
// "USB" (excludes the internal SCSI/NVMe/IDE system disk categorically,
// not just by heuristics about mount points — the same defense-in-depth
// rpi-imager uses per tuna-os/tacklebox#106), MediaType must indicate
// removable media, and size must be non-zero. excluded holds disk numbers
// that must never be offered (the system disk, the ISO's disk).
func FilterWindows(disks []WinDisk, excluded map[int]bool) []Drive {
	var safe []Drive
	for _, d := range disks {
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
