package drives

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Roots are variables so tests can point them at a fixture tree.
var (
	sysRoot       = "/sys"
	mountInfoPath = "/proc/self/mountinfo"
)

func enumerate(exclude string) ([]Drive, error) {
	mounts, err := readMountInfo(mountInfoPath)
	if err != nil {
		return nil, err
	}
	devs, err := scanSysfs(sysRoot, mounts)
	if err != nil {
		return nil, err
	}
	excluded := map[string]bool{}
	if exclude != "" {
		if abs, err := filepath.Abs(exclude); err == nil {
			exclude = abs
		}
		majMin := ""
		var st unix.Stat_t
		if unix.Stat(exclude, &st) == nil {
			majMin = fmt.Sprintf("%d:%d", unix.Major(uint64(st.Dev)), unix.Minor(uint64(st.Dev)))
		}
		if name := diskHolding(devs, majMin, exclude); name != "" {
			excluded[name] = true
		}
	}
	return filterSafeDrives(devs, excluded), nil
}

// mountTable maps block devices to mount points by maj:min and by the mount
// source's /dev name (btrfs reports an anonymous maj:min).
type mountTable struct {
	byMajMin map[string][]string
	byName   map[string][]string
}

func readMountInfo(path string) (mountTable, error) {
	t := mountTable{byMajMin: map[string][]string{}, byName: map[string][]string{}}
	f, err := os.Open(path)
	if err != nil {
		return t, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		// 36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw
		pre, post, ok := strings.Cut(sc.Text(), " - ")
		fields := strings.Fields(pre)
		if !ok || len(fields) < 5 {
			continue
		}
		mp := unescapeMount(fields[4])
		t.byMajMin[fields[2]] = append(t.byMajMin[fields[2]], mp)
		if pf := strings.Fields(post); len(pf) >= 2 && strings.HasPrefix(pf[1], "/dev/") {
			name := filepath.Base(pf[1])
			if target, err := filepath.EvalSymlinks(pf[1]); err == nil {
				name = filepath.Base(target)
			}
			t.byName[name] = append(t.byName[name], mp)
		}
	}
	return t, sc.Err()
}

// unescapeMount decodes mountinfo's octal escapes (\040 for space).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func readAttr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// virtualPrefixes are /sys/block entries that are never physical disks.
var virtualPrefixes = map[string]string{
	"loop": "loop", "ram": "ram", "zram": "zram", "dm-": "dm", "md": "raid",
	"sr": "rom", "nbd": "nbd", "fd": "fd", "zd": "zvol", "mtdblock": "mtd",
}

func devType(name string) string {
	for p, t := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return t
		}
	}
	return "disk"
}

// transport derives lsblk's TRAN from the device's sysfs path.
func transport(name, real string) string {
	switch {
	case strings.Contains(real, "/usb"):
		return "usb"
	case strings.HasPrefix(name, "nvme"):
		return "nvme"
	case strings.HasPrefix(name, "mmcblk"):
		return "mmc"
	case strings.Contains(real, "/ata"):
		return "sata"
	}
	return ""
}

// hotpluggable mirrors lsblk: the first "removable" attribute on the way up
// the device's parents decides ("removable" = hot-pluggable, "fixed" = not).
func hotpluggable(real, devicesRoot string) bool {
	for dir := filepath.Dir(real); strings.HasPrefix(dir, devicesRoot) && dir != devicesRoot; dir = filepath.Dir(dir) {
		switch readAttr(filepath.Join(dir, "removable")) {
		case "removable":
			return true
		case "fixed":
			return false
		}
	}
	return false
}

// serialOf is the disk's own serial attribute (NVMe, MMC) or, for USB
// storage, the serial of the USB device it hangs off (first parent with
// idVendor).
func serialOf(real, devicesRoot string) string {
	if s := readAttr(filepath.Join(real, "device", "serial")); s != "" {
		return s
	}
	for dir := filepath.Dir(real); strings.HasPrefix(dir, devicesRoot) && dir != devicesRoot; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "idVendor")); err == nil {
			return readAttr(filepath.Join(dir, "serial"))
		}
	}
	return ""
}

func scanSysfs(sys string, mounts mountTable) ([]blockDevice, error) {
	entries, err := os.ReadDir(filepath.Join(sys, "block"))
	if err != nil {
		return nil, err
	}
	devicesRoot := filepath.Join(sys, "devices")
	if r, err := filepath.EvalSymlinks(devicesRoot); err == nil {
		devicesRoot = r
	}
	mountsOf := func(name, majMin string) []string {
		out := append([]string(nil), mounts.byMajMin[majMin]...)
		for _, mp := range mounts.byName[name] {
			dup := false
			for _, have := range out {
				dup = dup || have == mp
			}
			if !dup {
				out = append(out, mp)
			}
		}
		return out
	}
	var holders func(dir string, depth int) []blockDevice
	holders = func(dir string, depth int) []blockDevice {
		if depth > 4 {
			return nil
		}
		hs, _ := os.ReadDir(filepath.Join(dir, "holders"))
		var out []blockDevice
		for _, h := range hs {
			hdir := filepath.Join(sys, "block", h.Name())
			mm := readAttr(filepath.Join(hdir, "dev"))
			out = append(out, blockDevice{
				Name: h.Name(), Type: devType(h.Name()), MajMin: mm,
				MountPoints: mountsOf(h.Name(), mm), Children: holders(hdir, depth+1),
			})
		}
		return out
	}
	var devs []blockDevice
	for _, e := range entries {
		name := e.Name()
		dir := filepath.Join(sys, "block", name)
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			real = dir
		}
		sectors, _ := strconv.ParseInt(readAttr(filepath.Join(dir, "size")), 10, 64)
		mm := readAttr(filepath.Join(dir, "dev"))
		d := blockDevice{
			Name:        name,
			Type:        devType(name),
			Size:        sectors * 512,
			RO:          readAttr(filepath.Join(dir, "ro")) == "1",
			RM:          readAttr(filepath.Join(dir, "removable")) == "1",
			HotPlug:     hotpluggable(real, devicesRoot),
			Tran:        transport(name, real),
			Model:       readAttr(filepath.Join(dir, "device", "model")),
			Vendor:      readAttr(filepath.Join(dir, "device", "vendor")),
			Serial:      serialOf(real, devicesRoot),
			MajMin:      mm,
			MountPoints: mountsOf(name, mm),
			Children:    holders(dir, 0),
		}
		if d.Model == "" {
			d.Model = readAttr(filepath.Join(dir, "device", "name")) // MMC/SD
		}
		parts, _ := os.ReadDir(dir)
		for _, p := range parts {
			pdir := filepath.Join(dir, p.Name())
			if _, err := os.Stat(filepath.Join(pdir, "partition")); err != nil {
				continue
			}
			pmm := readAttr(filepath.Join(pdir, "dev"))
			d.Children = append(d.Children, blockDevice{
				Name: p.Name(), Type: "part", MajMin: pmm,
				MountPoints: mountsOf(p.Name(), pmm), Children: holders(pdir, 0),
			})
		}
		devs = append(devs, d)
	}
	return devs, nil
}
