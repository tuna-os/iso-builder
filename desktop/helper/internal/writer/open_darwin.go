package writer

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// open unmounts every volume of the disk (`diskutil unmountDisk`) and opens
// its raw node /dev/rdiskN, which bypasses the buffer cache — so read-back
// needs no cache drop. The helper runs as root (the GUI elevates it).
func open(d drives.Drive, fd int) (*target, error) {
	if fd >= 0 {
		return nil, protocol.Errorf(protocol.KindUsage, "--fd is only supported on Linux.")
	}
	if d.Test {
		return openTestFile(d.Path)
	}
	if out, err := exec.Command("diskutil", "unmountDisk", d.Path).CombinedOutput(); err != nil {
		return nil, protocol.Wrap(protocol.KindPermission, fmt.Errorf("diskutil unmountDisk: %v: %s", err, strings.TrimSpace(string(out))),
			"The USB drive could not be unmounted. Close any files open on it and try again.")
	}
	raw := strings.Replace(d.Path, "/dev/disk", "/dev/rdisk", 1)
	f, err := os.OpenFile(raw, os.O_RDWR, 0)
	if err != nil {
		if os.IsPermission(err) {
			return nil, protocol.Wrap(protocol.KindPermission, err, "The app needs administrator permission to write to the USB drive.")
		}
		return nil, protocol.Wrap(protocol.KindDeviceChanged, err, "The selected USB drive was removed or replaced. Choose it again.")
	}
	return &target{
		dev:       f,
		size:      d.SizeBytes,
		dropCache: func() error { return nil },
		finish: func(eject bool) error {
			if err := f.Close(); err != nil {
				return err
			}
			if !eject {
				return nil
			}
			if out, err := exec.Command("diskutil", "eject", d.Path).CombinedOutput(); err != nil {
				return fmt.Errorf("diskutil eject: %v: %s", err, strings.TrimSpace(string(out)))
			}
			return nil
		},
	}, nil
}
