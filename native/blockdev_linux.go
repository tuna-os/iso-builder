package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type lsblkDevice struct {
	Name       string        `json:"name"`
	Model      string        `json:"model"`
	Size       int64         `json:"size"`
	Type       string        `json:"type"`
	RM         bool          `json:"rm"`      // removable
	RO         bool          `json:"ro"`      // read-only
	HotPlug    bool          `json:"hotplug"` // hot-pluggable bus
	Tran       string        `json:"tran"`    // transport: usb, nvme, sata, …
	MountPoint *string       `json:"mountpoint"`
	Children   []lsblkDevice `json:"children"`
}

type lsblkOutput struct {
	BlockDevices []lsblkDevice `json:"blockdevices"`
}

// removableMountRoots are where desktops auto-mount user-removable media. A
// mount under one of these is the *target drive mounting itself* (GNOME/
// Bluefin auto-mount every USB on insert), NOT the disk being in system use —
// so it must not disqualify the drive, or the user's intended target is
// invisible (observed on dilli: a USB SSD auto-mounted at /run/media/…).
var removableMountRoots = []string{"/run/media/", "/media/", "/mnt/"}

// hasSystemMount reports whether d or any descendant is mounted somewhere
// that means the disk is in use by the running system (root, /boot, /sysroot,
// swap, /home, …) — anything NOT under a removable-media root. Such a disk
// must never be a write target. A drive auto-mounted only under a removable
// root is still eligible (the writer unmounts it before writing).
func hasSystemMount(d lsblkDevice) bool {
	if mp := d.MountPoint; mp != nil && *mp != "" && !isRemovableMount(*mp) {
		return true
	}
	for _, c := range d.Children {
		if hasSystemMount(c) {
			return true
		}
	}
	return false
}

func isRemovableMount(mp string) bool {
	for _, root := range removableMountRoots {
		if strings.HasPrefix(mp, root) {
			return true
		}
	}
	return false
}

// isExternalDisk reports whether d is an external/removable disk (a legitimate
// write target) as opposed to an internal system disk. `rm` alone is wrong:
// USB SSD enclosures report rm=0, so keying on it hides them. The reliable
// signal is the transport bus — usb is external, nvme/sata are internal. rm
// still covers classic USB sticks/SD; hotplug is trusted only when the bus
// isn't a known-internal one (some internal NVMe bays report hotplug=1).
func isExternalDisk(d lsblkDevice) bool {
	if d.Tran == "usb" || d.RM {
		return true
	}
	if d.HotPlug && d.Tran != "nvme" && d.Tran != "sata" {
		return true
	}
	return false
}

// SafeWriteTargets enumerates whole disks via `lsblk` and returns only the
// ones filterSafeDrives accepts. This is the only function in the package
// that shells out; the actual safety decision lives in filterSafeDrives so
// it can be unit-tested without lsblk or root, on any OS — same split as
// tuna-os/tacklebox's darwin package (see tuna-os/tacklebox#106/#109 for
// why: the enumeration/filter boundary is the single most safety-critical
// code path for a non-technical audience, and has to be independently
// testable from the live OS call).
func SafeWriteTargets() ([]Drive, error) {
	out, err := exec.Command("lsblk", "-J", "-b", "-o", "NAME,MODEL,SIZE,TYPE,RM,RO,HOTPLUG,TRAN,MOUNTPOINT").Output()
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	var parsed lsblkOutput
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("parse lsblk output: %w", err)
	}
	return filterSafeDrives(parsed.BlockDevices), nil
}

// filterSafeDrives is the pure safety filter: a whole "disk" (not a
// partition), external (USB/removable, never an internal system disk), not
// read-only, non-zero size, and not in use by the running system (no
// non-removable-media mounts in its tree). No I/O, no root required — fully
// unit-testable.
func filterSafeDrives(devices []lsblkDevice) []Drive {
	var safe []Drive
	for _, d := range devices {
		if d.Type != "disk" {
			continue
		}
		if !isExternalDisk(d) {
			continue // internal system disk — never a write target
		}
		if d.RO {
			continue
		}
		if d.Size <= 0 {
			continue
		}
		if hasSystemMount(d) {
			continue
		}
		safe = append(safe, Drive{
			Path:  "/dev/" + d.Name,
			Model: d.Model,
			Size:  d.Size,
			SizeH: humanSize(d.Size),
		})
	}
	return safe
}
