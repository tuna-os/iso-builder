package writer

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/winvol"
)

// open locks and dismounts every volume on the disk (FSCTL_LOCK_VOLUME +
// FSCTL_DISMOUNT_VOLUME, held until the write ends) and opens
// \\.\PhysicalDriveN. Raw disk handles are not served from the file cache,
// so read-back needs no cache drop. The helper runs elevated (the GUI
// launches it with runas).
func open(d drives.Drive, fd int) (*target, error) {
	if fd >= 0 {
		return nil, protocol.Errorf(protocol.KindUsage, "--fd is only supported on Linux.")
	}
	if d.Test {
		return openTestFile(d.Path)
	}
	release, err := winvol.LockDisk(uint32(d.DiskNumber))
	if err != nil {
		return nil, protocol.Wrap(protocol.KindPermission, err, "The USB drive is in use. Close any files open on it and try again.")
	}
	p, err := windows.UTF16PtrFromString(fmt.Sprintf(`\\.\PhysicalDrive%d`, d.DiskNumber))
	if err != nil {
		release()
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_WRITE_THROUGH, 0)
	if err != nil {
		release()
		if err == windows.ERROR_ACCESS_DENIED {
			return nil, protocol.Wrap(protocol.KindPermission, err, "The app needs administrator permission to write to the USB drive.")
		}
		return nil, protocol.Wrap(protocol.KindDeviceChanged, err, "The selected USB drive was removed or replaced. Choose it again.")
	}
	f := os.NewFile(uintptr(h), d.Path)
	return &target{
		dev:       f,
		size:      d.SizeBytes,
		dropCache: func() error { return nil },
		finish: func(eject bool) error {
			var n uint32
			// Let Windows re-read the new partition table, then eject.
			_ = windows.DeviceIoControl(h, winvol.IoctlDiskUpdateProperties, nil, 0, nil, 0, &n, nil)
			var ejectErr error
			if eject {
				ejectErr = windows.DeviceIoControl(h, winvol.IoctlStorageEjectMedia, nil, 0, nil, 0, &n, nil)
			}
			f.Close()
			release()
			return ejectErr
		},
	}, nil
}
