package main

import (
	"encoding/json"
	"fmt"
	"os/exec"

	"github.com/tuna-os/iso-builder/safedrives"
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

// toShared converts lsblk trees to the shared filter input, keeping each
// disk's lsblk model for the native Drive label.
func toShared(devices []lsblkDevice) (inputs []safedrives.LinuxDevice, models map[string]string) {
	models = make(map[string]string, len(devices))
	for _, d := range devices {
		models[d.Name] = d.Model
		inputs = append(inputs, convertLsblkDevice(d))
	}
	return inputs, models
}

func convertLsblkDevice(d lsblkDevice) safedrives.LinuxDevice {
	out := safedrives.LinuxDevice{
		Name: d.Name, Model: d.Model, Size: d.Size, Type: d.Type,
		RM: d.RM, RO: d.RO, HotPlug: d.HotPlug, Tran: d.Tran,
	}
	if d.MountPoint != nil && *d.MountPoint != "" {
		out.MountPoints = []string{*d.MountPoint}
	}
	for _, c := range d.Children {
		out.Children = append(out.Children, convertLsblkDevice(c))
	}
	return out
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
	inputs, _ := toShared(parsed.BlockDevices)
	// The disk holding the running system is never a target, even when
	// lsblk shows it without a mountpoint (btrfs roots).
	excluded := map[string]bool{}
	if sys := safedrives.DiskHolding(inputs, "", "/"); sys != "" {
		excluded[sys] = true
	}
	return filterSafeDrives(parsed.BlockDevices, excluded), nil
}

// filterSafeDrives maps the shared decision to the native Drive type.
// excluded names disks to drop (the system disk, the disk holding the ISO).
// No I/O, no root required — fully unit-testable.
func filterSafeDrives(devices []lsblkDevice, excluded map[string]bool) []Drive {
	inputs, models := toShared(devices)
	var safe []Drive
	for _, c := range safedrives.FilterLinux(inputs, excluded) {
		name := c.Path[len("/dev/"):]
		safe = append(safe, Drive{
			Path:  c.Path,
			Model: models[name],
			Size:  c.SizeBytes,
			SizeH: humanSize(c.SizeBytes),
		})
	}
	return safe
}
