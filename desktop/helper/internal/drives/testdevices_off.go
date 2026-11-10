//go:build !testdevices

package drives

// TestDevicesEnabled reports whether this binary honours test devices.
// Release builds never do.
const TestDevicesEnabled = false

func testDevices() []Drive { return nil }
