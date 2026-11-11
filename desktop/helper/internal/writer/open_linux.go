package writer

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"golang.org/x/sys/unix"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// On Linux the GUI unmounts the drive's filesystems through udisks2 before
// calling write, and powers the drive off through udisks2 afterwards; the
// helper neither mounts, unmounts nor ejects.
func open(d drives.Drive, fd int) (*target, error) {
	if fd >= 0 {
		return openFD(d, fd)
	}
	if d.Test {
		return openTestFile(d.Path)
	}
	// O_EXCL on a block device fails with EBUSY while anything (a mounted
	// filesystem included) holds it — the kernel's own in-use check.
	n, err := unix.Open(d.Path, unix.O_RDWR|unix.O_EXCL|unix.O_CLOEXEC, 0)
	if err != nil {
		switch {
		case errors.Is(err, unix.EBUSY):
			return nil, protocol.Wrap(protocol.KindPermission, err, "The USB drive is still in use. Close any files open on it and try again.")
		case errors.Is(err, unix.EACCES), errors.Is(err, unix.EPERM):
			return nil, protocol.Wrap(protocol.KindPermission, err, "The app needs permission to write to the USB drive.")
		}
		return nil, protocol.Wrap(protocol.KindDeviceChanged, err, "The selected USB drive was removed or replaced. Choose it again.")
	}
	return linuxTarget(os.NewFile(uintptr(n), d.Path))
}

// openFD adopts a descriptor the GUI obtained from udisks2
// Block.OpenDevice("rw"). The device path may be invisible (Flatpak has no
// /dev), so identity is checked by rdev only when the path is visible.
func openFD(d drives.Drive, fd int) (*target, error) {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, protocol.Wrap(protocol.KindUsage, err, "The drive handle passed by the app is not valid.")
	}
	f := os.NewFile(uintptr(fd), "fd:"+strconv.Itoa(fd))
	if st.Mode&unix.S_IFMT == unix.S_IFBLK && !d.Test {
		var pst unix.Stat_t
		if unix.Stat(d.Path, &pst) == nil && pst.Rdev != st.Rdev {
			f.Close()
			return nil, protocol.Wrap(protocol.KindDeviceChanged, fmt.Errorf("fd %d is %d:%d, %s is %d:%d", fd,
				unix.Major(st.Rdev), unix.Minor(st.Rdev), d.Path, unix.Major(pst.Rdev), unix.Minor(pst.Rdev)),
				"The selected USB drive was removed or replaced. Choose it again.")
		}
	}
	t, err := linuxTarget(f)
	if err != nil {
		return nil, err
	}
	if t.size != d.SizeBytes {
		_ = t.finish(false)
		return nil, protocol.Wrap(protocol.KindDeviceChanged, fmt.Errorf("fd size %d != %d", t.size, d.SizeBytes),
			"The selected USB drive was removed or replaced. Choose it again.")
	}
	return t, nil
}

func linuxTarget(f *os.File) (*target, error) {
	size, err := drives.FileSize(f)
	if err != nil {
		f.Close()
		return nil, protocol.Wrap(protocol.KindStorage, err, "Could not read the USB drive's size.")
	}
	return &target{
		dev:  f,
		size: size,
		dropCache: func() error {
			fd := int(f.Fd())
			// Drop the block device's page cache so read-back hits the
			// medium. BLKFLSBUF needs CAP_SYS_ADMIN; fadvise does not.
			_ = unix.IoctlSetInt(fd, unix.BLKFLSBUF, 0)
			return unix.Fadvise(fd, 0, 0, unix.FADV_DONTNEED)
		},
		finish: func(bool) error { return f.Close() },
	}, nil
}
