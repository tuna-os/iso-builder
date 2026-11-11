package winvol

import (
	"encoding/binary"
	"fmt"
	"strings"

	"golang.org/x/sys/windows"
)

const (
	ioctlVolumeGetVolumeDiskExtents = 0x00560000
	fsctlLockVolume                 = 0x00090018
	fsctlDismountVolume             = 0x00090020
	fsctlUnlockVolume               = 0x0009001C
	// IoctlDiskUpdateProperties makes Windows re-read a disk's partition table.
	IoctlDiskUpdateProperties = 0x00070140
	// IoctlStorageEjectMedia ejects removable media.
	IoctlStorageEjectMedia = 0x002D4808
)

// Volume is one mounted or unmounted volume.
type Volume struct {
	GUIDPath   string   // \\?\Volume{...}\
	MountPaths []string // C:\, E:\, folder mounts
	Disks      []uint32 // physical disk numbers it spans
}

func openVolume(guidPath string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(strings.TrimSuffix(guidPath, `\`))
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
}

func disksOf(guidPath string) ([]uint32, error) {
	h, err := openVolume(guidPath, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, 8+24*32)
	var n uint32
	if err := windows.DeviceIoControl(h, ioctlVolumeGetVolumeDiskExtents, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		return nil, err
	}
	count := binary.LittleEndian.Uint32(buf[0:4])
	var disks []uint32
	for i := uint32(0); i < count && 8+24*(i+1) <= n; i++ {
		disks = append(disks, binary.LittleEndian.Uint32(buf[8+24*i:]))
	}
	return disks, nil
}

func mountPaths(guidPath string) []string {
	p, err := windows.UTF16PtrFromString(guidPath)
	if err != nil {
		return nil
	}
	buf := make([]uint16, 1024)
	var n uint32
	if err := windows.GetVolumePathNamesForVolumeName(p, &buf[0], uint32(len(buf)), &n); err != nil {
		return nil
	}
	var out []string
	start := 0
	for i := 0; i < int(n) && i < len(buf); i++ {
		if buf[i] == 0 {
			if i > start {
				out = append(out, windows.UTF16ToString(buf[start:i]))
			}
			start = i + 1
		}
	}
	return out
}

// Volumes lists every volume with its mount paths and disks. Volumes whose
// extents cannot be read (CD drives, unformatted) are skipped.
func Volumes() ([]Volume, error) {
	buf := make([]uint16, windows.MAX_PATH+1)
	h, err := windows.FindFirstVolume(&buf[0], uint32(len(buf)))
	if err != nil {
		return nil, err
	}
	defer windows.FindVolumeClose(h)
	var vols []Volume
	for {
		guid := windows.UTF16ToString(buf)
		if disks, err := disksOf(guid); err == nil {
			vols = append(vols, Volume{GUIDPath: guid, MountPaths: mountPaths(guid), Disks: disks})
		}
		if err := windows.FindNextVolume(h, &buf[0], uint32(len(buf))); err != nil {
			break
		}
	}
	return vols, nil
}

// DisksOfPath returns the physical disks under the volume holding path.
func DisksOfPath(path string) ([]uint32, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	root := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumePathName(p, &root[0], uint32(len(root))); err != nil {
		return nil, err
	}
	guid := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumeNameForVolumeMountPoint(&root[0], &guid[0], uint32(len(guid))); err != nil {
		return nil, err
	}
	return disksOf(windows.UTF16ToString(guid))
}

// MountPathsOfDisk lists the mount paths of every volume on disk.
func MountPathsOfDisk(disk uint32) []string {
	vols, err := Volumes()
	if err != nil {
		return nil
	}
	var out []string
	for _, v := range vols {
		for _, d := range v.Disks {
			if d == disk {
				out = append(out, v.MountPaths...)
			}
		}
	}
	return out
}

// LockDisk locks and dismounts every volume on disk. The returned release
// unlocks and closes them; call it only after the raw write is finished.
func LockDisk(disk uint32) (release func(), err error) {
	vols, err := Volumes()
	if err != nil {
		return nil, err
	}
	var held []windows.Handle
	release = func() {
		for _, h := range held {
			var n uint32
			_ = windows.DeviceIoControl(h, fsctlUnlockVolume, nil, 0, nil, 0, &n, nil)
			windows.CloseHandle(h)
		}
	}
	for _, v := range vols {
		on := false
		for _, d := range v.Disks {
			on = on || d == disk
		}
		if !on {
			continue
		}
		h, err := openVolume(v.GUIDPath, windows.GENERIC_READ|windows.GENERIC_WRITE)
		if err != nil {
			release()
			return nil, fmt.Errorf("open volume %s: %w", v.GUIDPath, err)
		}
		held = append(held, h)
		var n uint32
		if err := windows.DeviceIoControl(h, fsctlLockVolume, nil, 0, nil, 0, &n, nil); err != nil {
			release()
			return nil, fmt.Errorf("lock volume %s %v: %w", v.GUIDPath, v.MountPaths, err)
		}
		if err := windows.DeviceIoControl(h, fsctlDismountVolume, nil, 0, nil, 0, &n, nil); err != nil {
			release()
			return nil, fmt.Errorf("dismount volume %s %v: %w", v.GUIDPath, v.MountPaths, err)
		}
	}
	return release, nil
}
