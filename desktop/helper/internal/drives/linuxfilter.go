package drives

import "github.com/tuna-os/iso-builder/safedrives"

// This file has no build constraint on purpose (the native/ lesson: a
// filename-constrained filter is silently untested off its OS). The safety
// decision lives in the shared safedrives module
// (github.com/tuna-os/iso-builder/safedrives), imported by both this helper
// and native/; only the input is read from sysfs + mountinfo
// (sysfs_linux.go) instead of `lsblk -J`, which the Linux app's Flatpak
// sandbox does not have.

// blockDevice keeps its name so sysfs_linux.go and the tests read unchanged;
// it is the shared Linux input struct.
type blockDevice = safedrives.LinuxDevice

// filterSafeDrives maps the shared decision to this module's Drive type.
func filterSafeDrives(devices []blockDevice, excluded map[string]bool) []Drive {
	cands := safedrives.FilterLinux(devices, excluded)
	out := make([]Drive, 0, len(cands))
	for _, c := range cands {
		out = append(out, Drive{
			Path:      c.Path,
			Name:      c.Name,
			SizeBytes: c.SizeBytes,
			Bus:       c.Bus,
			Removable: c.Removable,
			Mounted:   c.Mounted,
			Ident:     c.Ident,
		})
	}
	return out
}

// diskHolding names the disk whose tree holds path; see
// safedrives.DiskHolding.
func diskHolding(devices []blockDevice, majMin, path string) string {
	return safedrives.DiskHolding(devices, majMin, path)
}
