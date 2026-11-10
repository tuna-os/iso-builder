package drives

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// Linux filter cases, ported from native/blockdev_linux_test.go.
func TestFilterSafeDrivesLinux(t *testing.T) {
	cases := []struct {
		name    string
		devices []blockDevice
		want    []string
	}{
		{"internal NVMe system disk rejected, USB stick accepted", []blockDevice{
			{Name: "nvme0n1", Model: "Samsung SSD 980", Size: 1000204886016, Type: "disk", Tran: "nvme",
				Children: []blockDevice{
					{Name: "nvme0n1p1", Type: "part", MountPoints: []string{"/boot/efi"}},
					{Name: "nvme0n1p2", Type: "part", MountPoints: []string{"/"}},
				}},
			{Name: "sdb", Model: "Generic Flash Disk", Size: 32000000000, Type: "disk", RM: true},
		}, []string{"/dev/sdb"}},
		{"unmounted internal disks rejected; hotplug does not override nvme", []blockDevice{
			{Name: "sda", Size: 32000000000, Type: "disk", Tran: "sata"},
			{Name: "nvme1n1", Size: 512000000000, Type: "disk", Tran: "nvme", HotPlug: true},
		}, nil},
		{"auto-mounted USB SSD (rm=0) offered", []blockDevice{
			{Name: "sdb", Model: "Portable SSD", Size: 1000204886016, Type: "disk", HotPlug: true, Tran: "usb",
				MountPoints: []string{"/run/media/james/TUNAOS"}},
		}, []string{"/dev/sdb"}},
		{"USB disk mounted as system root rejected", []blockDevice{
			{Name: "sdc", Size: 500000000000, Type: "disk", RM: true, Tran: "usb",
				Children: []blockDevice{{Name: "sdc1", Type: "part", MountPoints: []string{"/"}}}},
		}, nil},
		{"USB disk holding a mounted LVM volume rejected", []blockDevice{
			{Name: "sdc", Size: 500000000000, Type: "disk", Tran: "usb",
				Children: []blockDevice{{Name: "sdc1", Type: "part", Children: []blockDevice{
					{Name: "dm-0", Type: "dm", MountPoints: []string{"/home"}}}}}},
		}, nil},
		{"partition rejected", []blockDevice{{Name: "sdb1", Size: 32000000000, Type: "part", RM: true}}, nil},
		{"read-only rejected", []blockDevice{{Name: "sdb", Size: 32000000000, Type: "disk", RM: true, RO: true}}, nil},
		{"empty card reader rejected", []blockDevice{{Name: "sdd", Size: 0, Type: "disk", RM: true}}, nil},
		{"loop device rejected", []blockDevice{{Name: "loop0", Size: 1 << 30, Type: "loop", RM: false}}, nil},
		{"hotplug SD on an unknown bus offered", []blockDevice{{Name: "mmcblk0", Size: 64e9, Type: "disk", HotPlug: true, Tran: "mmc"}}, []string{"/dev/mmcblk0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := filterSafeDrives(c.devices, nil)
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

func TestFilterSafeDrivesLinuxFields(t *testing.T) {
	got := filterSafeDrives([]blockDevice{{
		Name: "sdb", Vendor: "SanDisk", Model: "Ultra", Serial: "4C530001", Size: 32e9, Type: "disk", RM: true, Tran: "usb",
		Children: []blockDevice{{Name: "sdb1", Type: "part", MountPoints: []string{"/run/media/u/STICK"}}},
	}}, nil)
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	d := finish(got)[0]
	if d.Name != "SanDisk Ultra" || d.Bus != "usb" || !d.Removable || d.Ident != "4C530001" ||
		len(d.Mounted) != 1 || d.Mounted[0] != "/run/media/u/STICK" || d.ID != "/dev/sdb|32000000000|4C530001" {
		t.Fatalf("fields: %+v", d)
	}
}

func TestExcludeISODisk(t *testing.T) {
	devs := []blockDevice{
		{Name: "nvme0n1", Type: "disk", Tran: "nvme", Children: []blockDevice{{Name: "nvme0n1p2", MajMin: "259:2", MountPoints: []string{"/"}}}},
		{Name: "sdb", Type: "disk", Size: 64e9, Tran: "usb", Children: []blockDevice{{Name: "sdb1", MajMin: "8:17", MountPoints: []string{"/run/media/u/DATA"}}}},
		{Name: "sdc", Type: "disk", Size: 32e9, Tran: "usb"},
	}
	// By st_dev.
	if got := diskHolding(devs, "8:17", "/run/media/u/DATA/tunaos.iso"); got != "sdb" {
		t.Fatalf("by maj:min: %q", got)
	}
	// btrfs-style anonymous st_dev: longest mount prefix wins over "/".
	if got := diskHolding(devs, "0:44", "/run/media/u/DATA/x/tunaos.iso"); got != "sdb" {
		t.Fatalf("by mount prefix: %q", got)
	}
	if got := diskHolding(devs, "0:44", "/run/media/u/DATAX/tunaos.iso"); got != "nvme0n1" {
		t.Fatalf("prefix must respect path boundaries: %q", got)
	}
	safe := filterSafeDrives(devs, map[string]bool{"sdb": true})
	if len(safe) != 1 || safe[0].Path != "/dev/sdc" {
		t.Fatalf("ISO disk not excluded: %+v", safe)
	}
}

// Windows cases, ported from native/blockdev_windows_test.go.
func TestFilterSafeDrivesWindows(t *testing.T) {
	disks := []win32DiskDrive{
		{DeviceID: `\\.\PHYSICALDRIVE0`, Model: "Samsung SSD 980 1TB", Size: 1000204886016, InterfaceType: "SCSI", MediaType: "Fixed hard disk media", Index: 0},
		{DeviceID: `\\.\PHYSICALDRIVE1`, Size: 32000000000, InterfaceType: "IDE", MediaType: "Removable Media", Index: 1},
		{DeviceID: `\\.\PHYSICALDRIVE2`, Model: "Generic Flash Disk USB Device ", Size: 32000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 2, SerialNumber: " 0123ABC "},
		{DeviceID: `\\.\PHYSICALDRIVE3`, Size: 500000000000, InterfaceType: "USB", MediaType: "Fixed hard disk media", Index: 3},
		{DeviceID: `\\.\PHYSICALDRIVE4`, Size: 0, InterfaceType: "USB", MediaType: "Removable Media", Index: 4},
		{DeviceID: `\\.\PHYSICALDRIVE5`, Size: 16000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 5},
	}
	safe := filterSafeDrivesWindows(disks, map[int]bool{5: true})
	if len(safe) != 1 || safe[0].Path != `\\.\PHYSICALDRIVE2` || safe[0].DiskNumber != 2 ||
		safe[0].Ident != "0123ABC" || safe[0].Name != "Generic Flash Disk USB Device" {
		t.Fatalf("got %+v", safe)
	}
}

func TestParseWin32DiskDrives(t *testing.T) {
	one, err := parseWin32DiskDrives([]byte(`{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Model":"Test","Size":1000,"InterfaceType":"SCSI","MediaType":"Fixed hard disk media","Index":0,"SerialNumber":null}`))
	if err != nil || len(one) != 1 || one[0].DeviceID != `\\.\PHYSICALDRIVE0` {
		t.Fatalf("single object: %v %+v", err, one)
	}
	many, err := parseWin32DiskDrives([]byte(`[{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Size":1000},{"DeviceID":"\\\\.\\PHYSICALDRIVE1","Size":2000,"Index":1}]`))
	if err != nil || len(many) != 2 || many[1].Index != 1 {
		t.Fatalf("array: %v %+v", err, many)
	}
	if none, err := parseWin32DiskDrives([]byte("  \n")); err != nil || none != nil {
		t.Fatalf("empty: %v %+v", err, none)
	}
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// macOS: the captured diskutil fixtures from tacklebox pkg/blockdev/darwin.
func TestDarwinFilter(t *testing.T) {
	l, err := decodeDiskutilList(readFixture(t, "diskutil-list.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if len(l.WholeDisks) == 0 {
		t.Fatal("no whole disks decoded")
	}
	// The startup volume lives on synthesized container disk3, whose
	// physical store is disk0s2: both are system disks.
	sys := physicalDisks(l, "/dev/disk3s1s1")
	if len(sys) != 2 || sys[0] != "disk3" || sys[1] != "disk0" {
		t.Fatalf("physicalDisks = %v", sys)
	}
	if m := mountsOn(l, "disk0"); len(m) == 0 {
		t.Fatal("APFS volumes on disk0's containers not attributed to disk0")
	}
	var infos []diskutilInfo
	for _, f := range []string{"diskutil-info-internal-ssd.plist", "diskutil-info-virtual-dmg.plist", "diskutil-info-usb-stick-synthetic.plist"} {
		info, err := decodeDiskutilInfo(readFixture(t, f))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		infos = append(infos, info)
	}
	safe := filterSafeDrivesDarwin(l, infos, map[string]bool{"disk0": true, "disk3": true})
	if len(safe) != 1 || safe[0].Bus != "usb" || safe[0].SizeBytes != 32000000000 || safe[0].Name != "Generic Flash Disk Media" {
		t.Fatalf("got %+v", safe)
	}
	// Excluding the stick (it holds the ISO) leaves nothing.
	if safe := filterSafeDrivesDarwin(l, infos, map[string]bool{infos[2].DeviceIdentifier: true}); len(safe) != 0 {
		t.Fatalf("excluded disk listed: %+v", safe)
	}
	if wholeDiskOf("/dev/disk12s3") != "disk12" || wholeDiskOf("devfs") != "" {
		t.Fatal("wholeDiskOf")
	}
}

func TestID(t *testing.T) {
	id := MakeID(`\\.\PHYSICALDRIVE2`, 32000000000, "SN|with|bars")
	p, size, ident, ok := ParseID(id)
	if !ok || p != `\\.\PHYSICALDRIVE2` || size != 32000000000 || ident != "SN|with|bars" {
		t.Fatalf("round trip: %q %d %q %v", p, size, ident, ok)
	}
	for _, bad := range []string{"", "/dev/sdb", "/dev/sdb|x|y", "|1|y", "/dev/sdb|0|"} {
		if _, _, _, ok := ParseID(bad); ok {
			t.Fatalf("ParseID(%q) accepted", bad)
		}
	}
}

func TestResolveRejectsUnknownID(t *testing.T) {
	_, err := Resolve("not-an-id", false)
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindUsage {
		t.Fatalf("got %v", err)
	}
}
