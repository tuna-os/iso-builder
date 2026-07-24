package main

import "testing"

func strp(s string) *string { return &s }

// TestFilterSafeDrives_RealShapedFixtures exercises the safety filter
// against device trees shaped like real `lsblk -J` output: an internal NVMe
// system disk (with mounted root/boot/home partitions, matching a typical
// desktop layout), and an unmounted removable USB stick. This must reject
// the former and accept the latter — the same category of assertion as
// tuna-os/tacklebox's darwin package (see tuna-os/tacklebox#113).
func TestFilterSafeDrives_RealShapedFixtures(t *testing.T) {
	devices := []lsblkDevice{
		{
			Name: "nvme0n1", Model: "Samsung SSD 980", Size: 1000204886016, Type: "disk", RM: false, RO: false,
			Children: []lsblkDevice{
				{Name: "nvme0n1p1", Size: 536870912, Type: "part", MountPoint: strp("/boot/efi")},
				{Name: "nvme0n1p2", Size: 999666009088, Type: "part", MountPoint: strp("/")},
			},
		},
		{
			Name: "sdb", Model: "Generic Flash Disk", Size: 32000000000, Type: "disk", RM: true, RO: false,
		},
	}

	safe := filterSafeDrives(devices)
	if len(safe) != 1 {
		t.Fatalf("expected exactly 1 safe drive, got %d: %+v", len(safe), safe)
	}
	if safe[0].Path != "/dev/sdb" {
		t.Errorf("expected /dev/sdb to be the safe drive, got %s", safe[0].Path)
	}
}

// An internal disk (no USB transport, not removable) must be rejected even
// when totally unmounted — a secondary SATA/NVMe data disk is never a write
// target. hotplug alone doesn't override a known-internal bus (NVMe bays).
func TestFilterSafeDrives_RejectsInternalDisk(t *testing.T) {
	devices := []lsblkDevice{
		{Name: "sda", Size: 32000000000, Type: "disk", RM: false, Tran: "sata"},
		{Name: "nvme1n1", Size: 512000000000, Type: "disk", RM: false, Tran: "nvme", HotPlug: true},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("internal disks must be rejected, got %+v", safe)
	}
}

// The dilli case: a USB SSD reports rm=0 (enclosure) and GNOME auto-mounts it
// under /run/media on insert. It MUST still be offered — that's the user's
// intended target. rm-only filtering + blanket mount-rejection hid it.
func TestFilterSafeDrives_AcceptsAutoMountedUSBSSD(t *testing.T) {
	devices := []lsblkDevice{
		{
			Name: "sdb", Model: "Portable SSD", Size: 1000204886016, Type: "disk",
			RM: false, RO: false, HotPlug: true, Tran: "usb",
			MountPoint: strp("/run/media/james/TUNAOS"),
		},
	}
	safe := filterSafeDrives(devices)
	if len(safe) != 1 || safe[0].Path != "/dev/sdb" {
		t.Fatalf("auto-mounted USB SSD must be offered, got %+v", safe)
	}
}

// Defense in depth: even a USB-transport disk must be rejected if it's mounted
// as part of the running system (e.g. booted from USB) — a non-removable-media
// mountpoint anywhere in its tree.
func TestFilterSafeDrives_RejectsUSBMountedAsSystem(t *testing.T) {
	devices := []lsblkDevice{
		{
			Name: "sdc", Size: 500000000000, Type: "disk", RM: true, Tran: "usb",
			Children: []lsblkDevice{
				{Name: "sdc1", Size: 500000000000, Type: "part", MountPoint: strp("/")},
			},
		},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("USB disk mounted as system root must be rejected, got %+v", safe)
	}
}

func TestFilterSafeDrives_RejectsPartitionType(t *testing.T) {
	devices := []lsblkDevice{
		{Name: "sdb1", Size: 32000000000, Type: "part", RM: true},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("a partition (type=part) must be rejected, got %+v", safe)
	}
}

func TestFilterSafeDrives_RejectsReadOnly(t *testing.T) {
	devices := []lsblkDevice{
		{Name: "sdb", Size: 32000000000, Type: "disk", RM: true, RO: true},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("a read-only device must be rejected, got %+v", safe)
	}
}

func TestHumanSize(t *testing.T) {
	cases := map[int64]string{
		500:         "500 B",
		32000000000: "29.8 GiB",
	}
	for size, want := range cases {
		if got := humanSize(size); got != want {
			t.Errorf("humanSize(%d) = %q, want %q", size, got, want)
		}
	}
}
