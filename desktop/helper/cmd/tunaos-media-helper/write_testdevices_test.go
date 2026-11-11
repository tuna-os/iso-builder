//go:build testdevices

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// drives → write → verify against a file-backed device, through the CLI.
func TestWriteThroughCLI(t *testing.T) {
	dir := t.TempDir()
	dev := filepath.Join(dir, "usb.img")
	if err := os.WriteFile(dev, make([]byte, 12<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	iso := filepath.Join(dir, "tunaos.iso")
	want := bytes.Repeat([]byte("TunaOS-ISO-"), 700000) // 7.7 MB, not 4 KiB aligned
	if err := os.WriteFile(iso, want, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(drives.EnvTestDevices, dev)

	code, evs := call(t, "drives")
	list, _ := last(evs)["drives"].([]any)
	var id string
	for _, d := range list {
		if m := d.(map[string]any); m["path"] == dev {
			id = m["id"].(string)
		}
	}
	if code != 0 || id == "" {
		t.Fatalf("test device not listed: %v", evs)
	}

	code, evs = call(t, "write", "--iso", iso, "--device", id)
	done := last(evs)
	if code != 0 || done["event"] != "done" || done["verified"] != true || done["bytes"] != float64(len(want)) || done["device"] != dev {
		t.Fatalf("%d %v", code, evs)
	}
	sawVerify := false
	for _, e := range evs {
		sawVerify = sawVerify || (e["phase"] == "verify" && e["current"] == float64(len(want)))
	}
	if !sawVerify {
		t.Fatal("no completed verify progress")
	}
	got, _ := os.ReadFile(dev)
	if !bytes.Equal(got[:len(want)], want) {
		t.Fatal("device content differs")
	}

	// The drive is swapped for one of another size: refuse.
	if err := os.Truncate(dev, 16<<20); err != nil {
		t.Fatal(err)
	}
	code, evs = call(t, "write", "--iso", iso, "--device", id, "--no-verify")
	if code != protocol.ExitFailure || last(evs)["kind"] != "device-changed" {
		t.Fatalf("%d %v", code, evs)
	}
}
