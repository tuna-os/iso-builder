package drives

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, target, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, name); err != nil {
		t.Fatal(err)
	}
}

// fakeSysfs builds the sysfs shape of a laptop: an internal NVMe system disk,
// a USB stick auto-mounted under /run/media and a loop device.
func fakeSysfs(t *testing.T) (sys, mountinfo string) {
	root := t.TempDir()
	sys = filepath.Join(root, "sys")

	usbDev := filepath.Join(sys, "devices/pci0000:00/0000:00:14.0/usb2/2-1")
	write(t, filepath.Join(usbDev, "idVendor"), "0781")
	write(t, filepath.Join(usbDev, "serial"), "4C530001231225117474")
	write(t, filepath.Join(usbDev, "removable"), "removable")
	scsi := filepath.Join(usbDev, "2-1:1.0/host6/target6:0:0/6:0:0:0")
	write(t, filepath.Join(scsi, "vendor"), "SanDisk ")
	write(t, filepath.Join(scsi, "model"), "Ultra           ")
	sdb := filepath.Join(scsi, "block/sdb")
	write(t, filepath.Join(sdb, "size"), "62521344")
	write(t, filepath.Join(sdb, "ro"), "0")
	write(t, filepath.Join(sdb, "removable"), "1")
	write(t, filepath.Join(sdb, "dev"), "8:16")
	write(t, filepath.Join(sdb, "sdb1/partition"), "1")
	write(t, filepath.Join(sdb, "sdb1/dev"), "8:17")
	link(t, "../..", filepath.Join(sdb, "device"))

	nvme := filepath.Join(sys, "devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0")
	write(t, filepath.Join(nvme, "model"), "Samsung SSD 980")
	write(t, filepath.Join(nvme, "serial"), "S64DNF0R")
	disk := filepath.Join(nvme, "nvme0n1")
	write(t, filepath.Join(disk, "size"), "1953525168")
	write(t, filepath.Join(disk, "ro"), "0")
	write(t, filepath.Join(disk, "removable"), "0")
	write(t, filepath.Join(disk, "dev"), "259:0")
	write(t, filepath.Join(disk, "nvme0n1p2/partition"), "2")
	write(t, filepath.Join(disk, "nvme0n1p2/dev"), "259:2")
	link(t, "..", filepath.Join(disk, "device"))

	loop := filepath.Join(sys, "devices/virtual/block/loop0")
	write(t, filepath.Join(loop, "size"), "2097152")
	write(t, filepath.Join(loop, "dev"), "7:0")

	link(t, "../devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb", filepath.Join(sys, "block/sdb"))
	link(t, "../devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1", filepath.Join(sys, "block/nvme0n1"))
	link(t, "../devices/virtual/block/loop0", filepath.Join(sys, "block/loop0"))

	mountinfo = filepath.Join(root, "mountinfo")
	write(t, mountinfo, "29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n"+
		"30 29 0:44 /home /home rw shared:2 - btrfs /dev/nvme0n1p2 rw\n"+
		`41 29 8:17 / /run/media/u/MY\040STICK rw,nosuid shared:9 - vfat /dev/sdb1 rw`)
	return sys, mountinfo
}

func TestSysfsEnumeration(t *testing.T) {
	sys, mi := fakeSysfs(t)
	sysRoot, mountInfoPath = sys, mi
	t.Cleanup(func() { sysRoot, mountInfoPath = "/sys", "/proc/self/mountinfo" })

	ds, err := enumerate("")
	if err != nil {
		t.Fatal(err)
	}
	ds = finish(ds)
	if len(ds) != 1 {
		t.Fatalf("want only the USB stick, got %+v", ds)
	}
	d := ds[0]
	if d.Path != "/dev/sdb" || d.SizeBytes != 62521344*512 || d.Name != "SanDisk Ultra" || d.Bus != "usb" ||
		!d.Removable || d.Ident != "4C530001231225117474" || len(d.Mounted) != 1 || d.Mounted[0] != "/run/media/u/MY STICK" {
		t.Fatalf("drive: %+v", d)
	}

	// The ISO saved on the stick excludes it (path-prefix match: the file
	// does not exist on this machine, so st_dev is unknown).
	ds, err = enumerate("/run/media/u/MY STICK/tunaos.iso")
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 0 {
		t.Fatalf("ISO disk listed: %+v", ds)
	}

	devs, err := scanSysfs(sys, mustMounts(t, mi))
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range devs {
		switch d.Name {
		case "nvme0n1":
			if d.Tran != "nvme" || d.HotPlug || d.Serial != "S64DNF0R" || !hasSystemMount(d) {
				t.Fatalf("nvme: %+v", d)
			}
		case "loop0":
			if d.Type != "loop" {
				t.Fatalf("loop: %+v", d)
			}
		case "sdb":
			if !d.HotPlug || d.Tran != "usb" {
				t.Fatalf("sdb: %+v", d)
			}
		}
	}
}

func mustMounts(t *testing.T, path string) mountTable {
	m, err := readMountInfo(path)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
