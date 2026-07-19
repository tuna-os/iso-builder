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

func TestFilterSafeDrives_RejectsNonRemovable(t *testing.T) {
	devices := []lsblkDevice{
		{Name: "sda", Size: 32000000000, Type: "disk", RM: false},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("non-removable disk must be rejected, got %+v", safe)
	}
}

func TestFilterSafeDrives_RejectsMountedRemovable(t *testing.T) {
	// A removable drive that's currently mounted somewhere (e.g. the user's
	// own already-plugged-in backup drive) must not be silently offered as
	// a write target.
	devices := []lsblkDevice{
		{
			Name: "sdc", Size: 500000000000, Type: "disk", RM: true,
			Children: []lsblkDevice{
				{Name: "sdc1", Size: 500000000000, Type: "part", MountPoint: strp("/media/user/backup")},
			},
		},
	}
	if safe := filterSafeDrives(devices); len(safe) != 0 {
		t.Fatalf("mounted removable drive must be rejected, got %+v", safe)
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
