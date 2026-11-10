//go:build testdevices

package drives

import (
	"os"
	"path/filepath"
	"strings"
)

// EnvTestDevices lists file-backed (or loop) test targets, comma-separated.
// Honoured only by binaries built with -tags testdevices; release builds do
// not contain this file.
const EnvTestDevices = "TUNAOS_MEDIA_HELPER_TEST_DEVICES"

// TestDevicesEnabled reports whether this binary honours EnvTestDevices.
const TestDevicesEnabled = true

func testDevices() []Drive {
	var out []Drive
	for _, p := range strings.Split(os.Getenv(EnvTestDevices), ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		size, err := deviceSize(p)
		if err != nil || size <= 0 {
			continue
		}
		out = append(out, Drive{
			Path: p, Name: "Test device " + filepath.Base(p), SizeBytes: size,
			Bus: "other", Removable: true, Ident: "test", Test: true,
		})
	}
	return out
}
