package drives

import "github.com/tuna-os/iso-builder/safedrives"

// No build constraint on purpose: the safety decision is unit-tested on
// every runner. The decision lives in the shared safedrives module,
// imported by both this helper and native/.

// win32DiskDrive keeps its name so enumerate_windows.go reads unchanged; it
// is the shared Windows input struct.
type win32DiskDrive = safedrives.WinDisk

// win32Script enumerates physical disks. -Depth/explicit properties because
// Win32_DiskDrive's default ConvertTo-Json output recurses through circular
// CIM association properties.
const win32Script = `Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,Size,InterfaceType,MediaType,Index,SerialNumber | ConvertTo-Json`

// parseWin32DiskDrives handles PowerShell's ConvertTo-Json quirk; see
// safedrives.ParseWin32DiskDrives.
func parseWin32DiskDrives(data []byte) ([]win32DiskDrive, error) {
	return safedrives.ParseWin32DiskDrives(data)
}

// filterSafeDrivesWindows maps the shared decision to this module's Drive
// type. excluded holds disk numbers that must never be offered (the system
// disk, the ISO's disk).
func filterSafeDrivesWindows(drives []win32DiskDrive, excluded map[int]bool) []Drive {
	cands := safedrives.FilterWindows(drives, excluded)
	out := make([]Drive, 0, len(cands))
	for _, c := range cands {
		out = append(out, Drive{
			Path:       c.Path,
			Name:       c.Name,
			SizeBytes:  c.SizeBytes,
			Bus:        c.Bus,
			Removable:  c.Removable,
			Mounted:    c.Mounted,
			Ident:      c.Ident,
			DiskNumber: c.DiskNumber,
		})
	}
	return out
}
