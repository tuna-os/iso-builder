package safedrives

import "testing"

// Union of the native writer's (native/blockdev_linux_test.go) and the
// helper's (desktop/helper/internal/drives/drives_test.go) Linux fixtures:
// every accept/reject decision both copies used to make on their own must
// come out of the shared filter.
func TestFilterLinux(t *testing.T) {
	cases := []struct {
		name    string
		devices []LinuxDevice
		want    []string
	}{
		{"internal NVMe system disk rejected, USB stick accepted", []LinuxDevice{
			{Name: "nvme0n1", Model: "Samsung SSD 980", Size: 1000204886016, Type: "disk", Tran: "nvme",
				Children: []LinuxDevice{
					{Name: "nvme0n1p1", Type: "part", MountPoints: []string{"/boot/efi"}},
					{Name: "nvme0n1p2", Type: "part", MountPoints: []string{"/"}},
				}},
			{Name: "sdb", Model: "Generic Flash Disk", Size: 32000000000, Type: "disk", RM: true},
		}, []string{"/dev/sdb"}},
		{"unmounted internal disks rejected; hotplug does not override nvme", []LinuxDevice{
			{Name: "sda", Size: 32000000000, Type: "disk", Tran: "sata"},
			{Name: "nvme1n1", Size: 512000000000, Type: "disk", Tran: "nvme", HotPlug: true},
		}, nil},
		{"auto-mounted USB SSD (rm=0) offered", []LinuxDevice{
			{Name: "sdb", Model: "Portable SSD", Size: 1000204886016, Type: "disk", HotPlug: true, Tran: "usb",
				MountPoints: []string{"/run/media/james/TUNAOS"}},
		}, []string{"/dev/sdb"}},
		{"USB disk mounted as system root rejected", []LinuxDevice{
			{Name: "sdc", Size: 500000000000, Type: "disk", RM: true, Tran: "usb",
				Children: []LinuxDevice{{Name: "sdc1", Type: "part", MountPoints: []string{"/"}}}},
		}, nil},
		{"USB disk holding a mounted LVM volume rejected", []LinuxDevice{
			{Name: "sdc", Size: 500000000000, Type: "disk", Tran: "usb",
				Children: []LinuxDevice{{Name: "sdc1", Type: "part", Children: []LinuxDevice{
					{Name: "dm-0", Type: "dm", MountPoints: []string{"/home"}}}}}},
		}, nil},
		{"partition rejected", []LinuxDevice{{Name: "sdb1", Size: 32000000000, Type: "part", RM: true}}, nil},
		{"read-only rejected", []LinuxDevice{{Name: "sdb", Size: 32000000000, Type: "disk", RM: true, RO: true}}, nil},
		{"empty card reader rejected", []LinuxDevice{{Name: "sdd", Size: 0, Type: "disk", RM: true}}, nil},
		{"loop device rejected", []LinuxDevice{{Name: "loop0", Size: 1 << 30, Type: "loop"}}, nil},
		{"optical drive rejected", []LinuxDevice{{Name: "sr0", Model: "DVD+-RW", Size: 4e9, Type: "rom", RM: true}}, nil},
		{"hotplug SD on an unknown bus offered", []LinuxDevice{{Name: "mmcblk0", Size: 64e9, Type: "disk", HotPlug: true, Tran: "mmc"}}, []string{"/dev/mmcblk0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := FilterLinux(c.devices, nil)
			var paths []string
			for _, d := range got {
				paths = append(paths, d.Path)
			}
			if len(paths) != len(c.want) {
				t.Fatalf("got %v, want %v", paths, c.want)
			}
			for i := range paths {
				if paths[i] != c.want[i] {
					t.Fatalf("got %v, want %v", paths, c.want)
				}
			}
		})
	}
}

func TestFilterLinuxFields(t *testing.T) {
	got := FilterLinux([]LinuxDevice{{
		Name: "sdb", Vendor: "SanDisk", Model: "Ultra", Serial: "4C530001", Size: 32e9, Type: "disk", RM: true, Tran: "usb",
		Children: []LinuxDevice{{Name: "sdb1", Type: "part", MountPoints: []string{"/run/media/u/STICK"}}},
	}}, nil)
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	d := got[0]
	if d.Name != "SanDisk Ultra" || d.Bus != "usb" || !d.Removable || d.Ident != "4C530001" ||
		len(d.Mounted) != 1 || d.Mounted[0] != "/run/media/u/STICK" || d.Path != "/dev/sdb" {
		t.Fatalf("fields: %+v", d)
	}
}

func TestFilterLinuxExcluded(t *testing.T) {
	devs := []LinuxDevice{
		{Name: "nvme0n1", Type: "disk", Tran: "nvme", Children: []LinuxDevice{{Name: "nvme0n1p2", MajMin: "259:2", MountPoints: []string{"/"}}}},
		{Name: "sdb", Type: "disk", Size: 64e9, Tran: "usb", Children: []LinuxDevice{{Name: "sdb1", MajMin: "8:17", MountPoints: []string{"/run/media/u/DATA"}}}},
		{Name: "sdc", Type: "disk", Size: 32e9, Tran: "usb"},
	}
	// By st_dev.
	if got := DiskHolding(devs, "8:17", "/run/media/u/DATA/tunaos.iso"); got != "sdb" {
		t.Fatalf("by maj:min: %q", got)
	}
	// btrfs-style anonymous st_dev: longest mount prefix wins over "/".
	if got := DiskHolding(devs, "0:44", "/run/media/u/DATA/x/tunaos.iso"); got != "sdb" {
		t.Fatalf("by mount prefix: %q", got)
	}
	if got := DiskHolding(devs, "0:44", "/run/media/u/DATAX/tunaos.iso"); got != "nvme0n1" {
		t.Fatalf("prefix must respect path boundaries: %q", got)
	}
	// An empty mount point never matches: it must not exclude an innocent disk.
	if got := DiskHolding([]LinuxDevice{{Name: "sdb", Type: "disk", MountPoints: []string{""}}}, "", "/run/media/u/DATA/x.iso"); got != "" {
		t.Fatalf("empty mount point matched: %q", got)
	}
	// The disk holding the ISO (or the system disk) is dropped.
	safe := FilterLinux(devs, map[string]bool{"sdb": true})
	if len(safe) != 1 || safe[0].Path != "/dev/sdc" {
		t.Fatalf("excluded disk listed: %+v", safe)
	}
	// The disk holding the running system is found without a maj:min.
	if got := DiskHolding(devs, "", "/"); got != "nvme0n1" {
		t.Fatalf("system disk: %q", got)
	}
}

func TestHasSystemMount(t *testing.T) {
	if HasSystemMount(LinuxDevice{MountPoints: []string{"/run/media/u/X"}}) {
		t.Fatal("removable mount is not a system mount")
	}
	if !HasSystemMount(LinuxDevice{Children: []LinuxDevice{{MountPoints: []string{"/"}}}}) {
		t.Fatal("child root mount is a system mount")
	}
	if HasSystemMount(LinuxDevice{}) {
		t.Fatal("unmounted device has no system mount")
	}
}
