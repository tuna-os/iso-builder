package drives

import (
	"regexp"
	"strings"

	"github.com/tuna-os/tacklebox/pkg/blockdev/darwin"
	"howett.net/plist"
)

// No build constraint on purpose: decoding and the safety decision are
// unit-tested on every runner. As in native/blockdev_darwin.go, the decision
// itself is tacklebox's darwin.IsSafeWriteTarget (whole disk, physical, not
// internal, non-zero size); the helper adds the system-disk and --exclude
// checks and the protocol fields.

// diskutilList is the part of `diskutil list -plist` the helper reads.
type diskutilList struct {
	WholeDisks            []string `plist:"WholeDisks"`
	AllDisksAndPartitions []struct {
		DeviceIdentifier string `plist:"DeviceIdentifier"`
		MountPoint       string `plist:"MountPoint"`
		Partitions       []struct {
			DeviceIdentifier string `plist:"DeviceIdentifier"`
			MountPoint       string `plist:"MountPoint"`
		} `plist:"Partitions"`
		APFSPhysicalStores []struct {
			DeviceIdentifier string `plist:"DeviceIdentifier"`
		} `plist:"APFSPhysicalStores"`
		APFSVolumes []struct {
			DeviceIdentifier string `plist:"DeviceIdentifier"`
			MountPoint       string `plist:"MountPoint"`
		} `plist:"APFSVolumes"`
	} `plist:"AllDisksAndPartitions"`
}

// diskutilInfo extends tacklebox's DiskInfo with the fields the protocol
// reports.
type diskutilInfo struct {
	darwin.DiskInfo
	Ejectable bool `plist:"Ejectable"`
	Removable bool `plist:"Removable"`
}

func decodeDiskutilList(b []byte) (diskutilList, error) {
	var l diskutilList
	_, err := plist.Unmarshal(b, &l)
	return l, err
}

func decodeDiskutilInfo(b []byte) (diskutilInfo, error) {
	var i diskutilInfo
	_, err := plist.Unmarshal(b, &i.DiskInfo)
	if err != nil {
		return i, err
	}
	var extra struct {
		Ejectable bool `plist:"Ejectable"`
		Removable bool `plist:"Removable"`
	}
	_, err = plist.Unmarshal(b, &extra)
	i.Ejectable, i.Removable = extra.Ejectable, extra.Removable
	return i, err
}

var wholeDiskRE = regexp.MustCompile(`^(?:/dev/)?(disk[0-9]+)`)

// wholeDiskOf maps a BSD name (disk4s1, /dev/disk3s1s1) to its whole disk.
func wholeDiskOf(bsd string) string {
	m := wholeDiskRE.FindStringSubmatch(bsd)
	if m == nil {
		return ""
	}
	return m[1]
}

// physicalDisks returns the whole disk of bsd plus, when that disk is a
// synthesized APFS container, the whole disks of its physical stores: the
// disks that must never be written while bsd is in use.
func physicalDisks(l diskutilList, bsd string) []string {
	whole := wholeDiskOf(bsd)
	if whole == "" {
		return nil
	}
	out := []string{whole}
	for _, d := range l.AllDisksAndPartitions {
		if d.DeviceIdentifier != whole {
			continue
		}
		for _, s := range d.APFSPhysicalStores {
			if w := wholeDiskOf(s.DeviceIdentifier); w != "" && w != whole {
				out = append(out, w)
			}
		}
	}
	return out
}

// mountsOn lists mount points living on whole disk id: its own partitions and
// the volumes of APFS containers whose physical store is on it.
func mountsOn(l diskutilList, id string) []string {
	var out []string
	for _, d := range l.AllDisksAndPartitions {
		onDisk := d.DeviceIdentifier == id
		for _, s := range d.APFSPhysicalStores {
			onDisk = onDisk || wholeDiskOf(s.DeviceIdentifier) == id
		}
		if !onDisk {
			continue
		}
		if d.MountPoint != "" {
			out = append(out, d.MountPoint)
		}
		for _, p := range d.Partitions {
			if p.MountPoint != "" {
				out = append(out, p.MountPoint)
			}
		}
		for _, v := range d.APFSVolumes {
			if v.MountPoint != "" {
				out = append(out, v.MountPoint)
			}
		}
	}
	return out
}

// filterSafeDrivesDarwin applies tacklebox's IsSafeWriteTarget plus the
// excluded (system / ISO) disks.
func filterSafeDrivesDarwin(l diskutilList, infos []diskutilInfo, excluded map[string]bool) []Drive {
	var safe []Drive
	for _, info := range infos {
		if ok, _ := darwin.IsSafeWriteTarget(info.DiskInfo); !ok {
			continue
		}
		if excluded[info.DeviceIdentifier] {
			continue
		}
		bus := "other"
		switch strings.ToLower(info.BusProtocol) {
		case "usb":
			bus = "usb"
		case "secure digital", "sd":
			bus = "sd"
		}
		safe = append(safe, Drive{
			Path:      "/dev/" + info.DeviceIdentifier,
			Name:      strings.TrimSpace(info.MediaName),
			SizeBytes: info.Size,
			Bus:       bus,
			Removable: info.RemovableMedia || info.Removable || info.Ejectable,
			Mounted:   mountsOn(l, info.DeviceIdentifier),
			// diskutil reports no serial; the media name is the identity
			// re-checked alongside path and exact size.
			Ident: strings.TrimSpace(info.MediaName),
		})
	}
	return safe
}
