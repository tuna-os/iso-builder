package safedrives

import "strings"

// LinuxDevice is the input to FilterLinux: the lsblk fields the filter
// needs, read from `lsblk -J` by the native writer or from sysfs +
// mountinfo by the helper (which the Flatpak sandbox can see).
type LinuxDevice struct {
	Name        string
	Model       string
	Vendor      string
	Serial      string
	Size        int64
	Type        string // "disk", "part", "dm", "loop", "rom", ...
	RM          bool   // removable
	RO          bool   // read-only
	HotPlug     bool   // hot-pluggable bus
	Tran        string // transport: usb, nvme, sata, mmc, ...
	MajMin      string
	MountPoints []string
	Children    []LinuxDevice
}

// RemovableMountRoots are where desktops auto-mount user-removable media. A
// mount under one of these is the *target drive mounting itself* (GNOME/
// Bluefin auto-mount every USB on insert), NOT the disk being in system use —
// so it must not disqualify the drive, or the user's intended target is
// invisible (observed on dilli: a USB SSD auto-mounted at /run/media/…).
var RemovableMountRoots = []string{"/run/media/", "/media/", "/mnt/"}

// HasSystemMount reports whether d or any descendant is mounted somewhere
// that means the disk is in use by the running system (root, /boot, /sysroot,
// swap, /home, …) — anything NOT under a removable-media root. Such a disk
// must never be a write target. A drive auto-mounted only under a removable
// root is still eligible (the GUI unmounts it before writing).
func HasSystemMount(d LinuxDevice) bool {
	for _, mp := range d.MountPoints {
		if mp != "" && !IsRemovableMount(mp) {
			return true
		}
	}
	for _, c := range d.Children {
		if HasSystemMount(c) {
			return true
		}
	}
	return false
}

// IsRemovableMount reports whether mp is under a removable-media root.
func IsRemovableMount(mp string) bool {
	for _, root := range RemovableMountRoots {
		if strings.HasPrefix(mp, root) {
			return true
		}
	}
	return false
}

// IsExternalDisk reports whether d is an external/removable disk (a legitimate
// write target) as opposed to an internal system disk. `rm` alone is wrong:
// USB SSD enclosures report rm=0, so keying on it hides them. The reliable
// signal is the transport bus — usb is external, nvme/sata are internal. rm
// still covers classic USB sticks/SD; hotplug is trusted only when the bus
// isn't a known-internal one (some internal NVMe bays report hotplug=1).
func IsExternalDisk(d LinuxDevice) bool {
	if d.Tran == "usb" || d.RM {
		return true
	}
	if d.HotPlug && d.Tran != "nvme" && d.Tran != "sata" {
		return true
	}
	return false
}

func allMounts(d LinuxDevice) []string {
	out := append([]string(nil), d.MountPoints...)
	for _, c := range d.Children {
		out = append(out, allMounts(c)...)
	}
	return out
}

// FilterLinux is the pure safety filter: a whole "disk" (not a
// partition), external (USB/removable, never an internal system disk), not
// read-only, non-zero size, and not in use by the running system (no
// non-removable-media mounts in its tree). excluded names disks to drop
// (the system disk, the one holding the ISO).
func FilterLinux(devices []LinuxDevice, excluded map[string]bool) []Drive {
	var safe []Drive
	for _, d := range devices {
		if d.Type != "disk" {
			continue
		}
		if !IsExternalDisk(d) {
			continue // internal system disk — never a write target
		}
		if d.RO {
			continue
		}
		if d.Size <= 0 {
			continue
		}
		if HasSystemMount(d) {
			continue
		}
		if excluded[d.Name] {
			continue
		}
		bus := "other"
		switch {
		case d.Tran == "usb":
			bus = "usb"
		case d.Tran == "mmc" || strings.HasPrefix(d.Name, "mmcblk"):
			bus = "sd"
		}
		ident := d.Serial
		if ident == "" {
			ident = d.Model
		}
		safe = append(safe, Drive{
			Path:      "/dev/" + d.Name,
			Name:      displayName(d.Vendor, d.Model),
			SizeBytes: d.Size,
			Bus:       bus,
			Removable: d.RM,
			Mounted:   allMounts(d),
			Ident:     ident,
		})
	}
	return safe
}

func displayName(vendor, model string) string {
	vendor, model = strings.TrimSpace(vendor), strings.TrimSpace(model)
	switch {
	case vendor == "" || strings.HasPrefix(strings.ToLower(model), strings.ToLower(vendor)):
		return model
	case model == "":
		return vendor
	}
	return vendor + " " + model
}

// DiskHolding names the disk whose tree holds path: the device whose
// maj:min equals majMin (the stat st_dev of path), or failing that (btrfs and
// other filesystems report an anonymous st_dev) the device with the longest
// mount point that prefixes path.
func DiskHolding(devices []LinuxDevice, majMin, path string) string {
	var contains func(d LinuxDevice) bool
	contains = func(d LinuxDevice) bool {
		if majMin != "" && d.MajMin == majMin {
			return true
		}
		for _, c := range d.Children {
			if contains(c) {
				return true
			}
		}
		return false
	}
	for _, d := range devices {
		if contains(d) {
			return d.Name
		}
	}
	best, bestLen := "", -1
	for _, d := range devices {
		for _, mp := range allMounts(d) {
			if under(path, mp) && len(mp) > bestLen {
				best, bestLen = d.Name, len(mp)
			}
		}
	}
	return best
}

func under(path, mp string) bool {
	if mp == "" {
		return false
	}
	if mp == "/" {
		return strings.HasPrefix(path, "/")
	}
	return path == mp || strings.HasPrefix(path, strings.TrimRight(mp, "/")+"/")
}
