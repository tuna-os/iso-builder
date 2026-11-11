//go:build testdevices

package writer

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// fakeDevice creates a file-backed test device of size bytes, registers it
// through drives.EnvTestDevices and returns its re-resolved Drive.
func fakeDevice(t *testing.T, size int64) drives.Drive {
	t.Helper()
	p := filepath.Join(t.TempDir(), "usb.img")
	if err := os.WriteFile(p, bytes.Repeat([]byte{0x5A}, int(size)), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(drives.EnvTestDevices, p)
	list, err := drives.List("")
	if err != nil || len(list) == 0 {
		t.Fatalf("test device not listed: %v %+v", err, list)
	}
	d, err := drives.Resolve(list[len(list)-1].ID, false)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func isoFile(t *testing.T, n int) (string, []byte) {
	b := randomISO(t, n)
	p := filepath.Join(t.TempDir(), "tunaos.iso")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, b
}

func TestRunFileBackedDevice(t *testing.T) {
	d := fakeDevice(t, 16<<20)
	iso, want := isoFile(t, 9<<20+2048)
	res, err := Run(context.Background(), Options{ISO: iso, Device: d, FD: -1, Verify: true, Emitter: protocol.NewEmitter(&bytes.Buffer{})})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Verified || res.Bytes != int64(len(want)) || res.Device != d.Path || res.Event != "done" {
		t.Fatalf("result %+v", res)
	}
	got, _ := os.ReadFile(d.Path)
	if !bytes.Equal(got[:len(want)], want) {
		t.Fatal("device does not hold the ISO")
	}
	if int64(len(got)) != d.SizeBytes {
		t.Fatalf("device grew to %d", len(got))
	}
}

func TestRunDeviceTooSmall(t *testing.T) {
	d := fakeDevice(t, 1<<20)
	iso, _ := isoFile(t, 2<<20)
	_, err := Run(context.Background(), Options{ISO: iso, Device: d, FD: -1, Verify: true, Emitter: protocol.NewEmitter(&bytes.Buffer{})})
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindStorage || pe.Extra["requiredBytes"] != int64(2<<20) {
		t.Fatalf("got %v", err)
	}
}

func TestResolveDetectsReplacedDevice(t *testing.T) {
	d := fakeDevice(t, 4<<20)
	if err := os.Truncate(d.Path, 8<<20); err != nil {
		t.Fatal(err)
	}
	_, err := drives.Resolve(d.ID, false)
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindDeviceChanged {
		t.Fatalf("size change not detected: %v", err)
	}
	if err := os.Remove(d.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := drives.Resolve(d.ID, false); !errors.As(err, &pe) || pe.Kind != protocol.KindDeviceChanged {
		t.Fatalf("removal not detected: %v", err)
	}
}
