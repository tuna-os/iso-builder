package main

import "github.com/tuna-os/tacklebox/pkg/blockdev/darwin"

// SafeWriteTargets on macOS delegates entirely to tacklebox's own
// enumeration/filter (tuna-os/tacklebox#108/#113) rather than
// reimplementing it — same diskutil-plist-based logic, unit-tested there
// against real captured fixtures.
func SafeWriteTargets() ([]Drive, error) {
	found, err := darwin.SafeWriteTargets()
	if err != nil {
		return nil, err
	}
	drives := make([]Drive, len(found))
	for i, d := range found {
		drives[i] = Drive{
			Path:  "/dev/" + d.DeviceIdentifier,
			Model: d.MediaName,
			Size:  d.Size,
			SizeH: humanSize(d.Size),
		}
	}
	return drives, nil
}
