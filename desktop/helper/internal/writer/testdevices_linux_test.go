//go:build testdevices

package writer

import (
	"bytes"
	"context"
	"os"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// The Linux Flatpak path: the GUI hands over an fd from udisks2
// Block.OpenDevice("rw"); the helper writes and reads back through it.
func TestRunInheritedFD(t *testing.T) {
	d := fakeDevice(t, 8<<20)
	iso, want := isoFile(t, 5<<20+512)
	f, err := os.OpenFile(d.Path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Run owns the descriptor from here on, like the helper process does.
	fd, err := unix.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	// A bare path is accepted as the device ID under --fd.
	d, err = drives.Resolve(d.Path, true)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), Options{ISO: iso, Device: d, FD: fd, Verify: true, Emitter: protocol.NewEmitter(&bytes.Buffer{})})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(d.Path)
	if !res.Verified || !bytes.Equal(got[:len(want)], want) {
		t.Fatalf("result %+v", res)
	}
}
