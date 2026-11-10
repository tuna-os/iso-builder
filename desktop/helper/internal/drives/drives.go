// Package drives enumerates the USB drives the Media Writer may offer as a
// write target. The safety filters are ported from native/blockdev_*.go (the
// older Fyne app): only whole, external/removable, writable, non-empty disks
// that the running system does not use are ever listed. The system/boot disk
// and the disk holding --exclude PATH (the ISO's own disk) never are.
package drives

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// Drive is one entry of the protocol `drives` event.
type Drive struct {
	ID         string   `json:"id"`
	Path       string   `json:"path"`
	Name       string   `json:"name"`
	SizeBytes  int64    `json:"sizeBytes"`
	Bus        string   `json:"bus"`
	Removable  bool     `json:"removable"`
	Mounted    []string `json:"mounted"`
	SystemDisk bool     `json:"systemDisk"`

	// Ident is the disk serial when the OS reports one, else its model; it
	// is part of the ID and re-checked before writing.
	Ident string `json:"-"`
	// Test marks a file-backed test device (testdevices build tag only).
	Test bool `json:"-"`
	// DiskNumber is the Windows physical disk number.
	DiskNumber int `json:"-"`
}

// Event is the protocol `drives` event.
type Event struct {
	Event  string  `json:"event"`
	Drives []Drive `json:"drives"`
}

// MakeID encodes the identity re-checked before writing: path, exact size
// and serial (or model). The GUI treats it as opaque.
func MakeID(path string, size int64, ident string) string {
	return path + "|" + strconv.FormatInt(size, 10) + "|" + ident
}

// ParseID splits a MakeID value.
func ParseID(id string) (path string, size int64, ident string, ok bool) {
	parts := strings.SplitN(id, "|", 3)
	if len(parts) != 3 || parts[0] == "" {
		return "", 0, "", false
	}
	size, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || size <= 0 {
		return "", 0, "", false
	}
	return parts[0], size, parts[2], true
}

func finish(ds []Drive) []Drive {
	out := make([]Drive, 0, len(ds))
	for _, d := range ds {
		if d.Mounted == nil {
			d.Mounted = []string{}
		}
		if d.Name == "" {
			d.Name = "USB drive"
		}
		d.ID = MakeID(d.Path, d.SizeBytes, d.Ident)
		out = append(out, d)
	}
	return out
}

// List enumerates safe write targets, never the disk holding exclude.
func List(exclude string) ([]Drive, error) {
	ds, err := enumerate(exclude)
	if err != nil {
		return nil, protocol.Wrap(protocol.KindPermission, err, "Could not list the connected drives.")
	}
	return finish(append(ds, testDevices()...)), nil
}

// Resolve re-enumerates right before a write and returns the drive id names,
// failing with `device-changed` if it is gone or its size or serial differ
// (a serial is compared only when both sides report one). With allowPath, a
// bare device path is accepted as id and matched on path alone: the Linux
// Flatpak GUI holds an fd from udisks2 for exactly that device.
func Resolve(id string, allowPath bool) (Drive, error) {
	path, size, ident, ok := ParseID(id)
	if !ok {
		if !allowPath || !strings.HasPrefix(id, "/") {
			return Drive{}, protocol.Errorf(protocol.KindUsage, "Unknown drive %q.", id)
		}
		path, size = id, -1
	}
	list, err := List("")
	if err != nil {
		return Drive{}, err
	}
	for _, d := range list {
		if d.Path != path {
			continue
		}
		if size >= 0 && d.SizeBytes != size {
			return Drive{}, changed(fmt.Errorf("size %d != %d", d.SizeBytes, size))
		}
		if ident != "" && d.Ident != "" && ident != d.Ident {
			return Drive{}, changed(fmt.Errorf("identity %q != %q", d.Ident, ident))
		}
		return d, nil
	}
	return Drive{}, changed(fmt.Errorf("%s is no longer a safe write target", path))
}

func changed(err error) error {
	return protocol.Wrap(protocol.KindDeviceChanged, err, "The selected USB drive was removed or replaced. Choose it again.")
}
