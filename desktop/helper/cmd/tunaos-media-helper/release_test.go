//go:build !testdevices

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Release builds never offer a file as a drive, whatever the environment says.
func TestReleaseBuildIgnoresTestDevices(t *testing.T) {
	dev := filepath.Join(t.TempDir(), "usb.img")
	if err := os.WriteFile(dev, make([]byte, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUNAOS_MEDIA_HELPER_TEST_DEVICES", dev)
	code, evs := call(t, "drives")
	for _, d := range last(evs)["drives"].([]any) {
		if strings.Contains(d.(map[string]any)["path"].(string), "usb.img") {
			t.Fatalf("release build listed a test device: %v", d)
		}
	}
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	code, evs = call(t, "write", "--iso", dev, "--device", dev+"|1048576|test")
	if code == 0 || last(evs)["kind"] != "device-changed" {
		t.Fatalf("release build wrote to a test device: %d %v", code, evs)
	}
}
