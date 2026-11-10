package engine

import (
	"strings"

	"golang.org/x/sys/windows"
)

func freeBytes(dir string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var avail, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, &total, &free); err != nil {
		return 0, err
	}
	return avail, nil
}

func volumeOf(path string) string {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	buf := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumePathName(p, &buf[0], uint32(len(buf))); err != nil {
		return ""
	}
	return strings.ToLower(windows.UTF16ToString(buf))
}

func sameVolume(a, b string) bool {
	va, vb := volumeOf(a), volumeOf(b)
	return va == "" || vb == "" || va == vb
}
