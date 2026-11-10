package drives

import (
	"fmt"
	"os/exec"

	"golang.org/x/sys/unix"
)

// mountedFrom is the device a path's filesystem is mounted from
// (statfs f_mntfromname, e.g. /dev/disk3s1s1).
func mountedFrom(path string) string {
	var st unix.Statfs_t
	if unix.Statfs(path, &st) != nil {
		return ""
	}
	return unix.ByteSliceToString(st.Mntfromname[:])
}

func enumerate(exclude string) ([]Drive, error) {
	out, err := exec.Command("diskutil", "list", "-plist").Output()
	if err != nil {
		return nil, fmt.Errorf("diskutil list: %w", err)
	}
	l, err := decodeDiskutilList(out)
	if err != nil {
		return nil, fmt.Errorf("parse diskutil list: %w", err)
	}
	excluded := map[string]bool{}
	for _, p := range []string{"/", exclude} {
		if p == "" {
			continue
		}
		for _, d := range physicalDisks(l, mountedFrom(p)) {
			excluded[d] = true
		}
	}
	if !excluded[wholeDiskOf(mountedFrom("/"))] {
		return nil, fmt.Errorf("could not identify the startup disk")
	}
	var infos []diskutilInfo
	for _, id := range l.WholeDisks {
		b, err := exec.Command("diskutil", "info", "-plist", id).Output()
		if err != nil {
			continue // unplugged between list and info
		}
		info, err := decodeDiskutilInfo(b)
		if err != nil {
			continue
		}
		infos = append(infos, info)
	}
	return filterSafeDrivesDarwin(l, infos, excluded), nil
}
