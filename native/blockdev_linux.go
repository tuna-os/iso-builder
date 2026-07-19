package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
)

// Drive is a candidate write target, already filtered to what's safe to
// offer a non-technical user.
type Drive struct {
	Path  string // e.g. /dev/sda
	Model string
	SizeH string // human-readable size, e.g. "32G"
	Size  int64  // bytes
}

type lsblkDevice struct {
	Name       string        `json:"name"`
	Model      string        `json:"model"`
	Size       int64         `json:"size"`
	Type       string        `json:"type"`
	RM         bool          `json:"rm"`   // removable
	RO         bool          `json:"ro"`   // read-only
	MountPoint *string       `json:"mountpoint"`
	Children   []lsblkDevice `json:"children"`
}

type lsblkOutput struct {
	BlockDevices []lsblkDevice `json:"blockdevices"`
}

// hasSystemMount reports whether d or any descendant partition is mounted
// at a path that would make d unsafe to overwrite (root, /boot, /home,
// swap, etc). This is the same category of check as
// darwin.IsSafeWriteTarget in the tacklebox macOS work — see
// tuna-os/tacklebox#106 for why this check has to be conservative.
func hasSystemMount(d lsblkDevice) bool {
	if d.MountPoint != nil && *d.MountPoint != "" {
		return true
	}
	for _, c := range d.Children {
		if hasSystemMount(c) {
			return true
		}
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
	out, err := exec.Command("lsblk", "-J", "-b", "-o", "NAME,MODEL,SIZE,TYPE,RM,RO,MOUNTPOINT").Output()
	if err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	var parsed lsblkOutput
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("parse lsblk output: %w", err)
	}
	return filterSafeDrives(parsed.BlockDevices), nil
}

// filterSafeDrives is the pure safety filter: type "disk" (not a
// partition), removable, not read-only, no mounted partitions anywhere in
// its tree, and non-zero size. No I/O, no root required — fully
// unit-testable.
func filterSafeDrives(devices []lsblkDevice) []Drive {
	var safe []Drive
	for _, d := range devices {
		if d.Type != "disk" {
			continue
		}
		if !d.RM {
			continue // not removable
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

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
