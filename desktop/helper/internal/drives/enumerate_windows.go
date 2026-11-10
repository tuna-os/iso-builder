package drives

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/winvol"
)

func enumerate(exclude string) ([]Drive, error) {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", win32Script).Output()
	if err != nil {
		return nil, fmt.Errorf("Get-CimInstance Win32_DiskDrive: %w", err)
	}
	disks, err := parseWin32DiskDrives(out)
	if err != nil {
		return nil, err
	}
	excluded := map[int]bool{}
	sysDrive := os.Getenv("SystemDrive")
	if sysDrive == "" {
		sysDrive = "C:"
	}
	for _, p := range []string{sysDrive + `\`, exclude} {
		if p == "" {
			continue
		}
		nums, err := winvol.DisksOfPath(p)
		if err != nil && p != exclude {
			return nil, fmt.Errorf("locate system disk: %w", err)
		}
		for _, n := range nums {
			excluded[int(n)] = true
		}
	}
	safe := filterSafeDrivesWindows(disks, excluded)
	for i := range safe {
		safe[i].Mounted = winvol.MountPathsOfDisk(uint32(safe[i].DiskNumber))
	}
	return safe, nil
}
