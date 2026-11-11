package writer

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// memDevice is an in-memory raw device that records every transfer and
// rejects unaligned ones, like /dev/rdisk and \\.\PhysicalDrive do.
type memDevice struct {
	mu        sync.Mutex
	data      []byte
	writes    [][2]int64
	corruptAt int64 // flip a byte here on read (-1 = never)
	onWrite   func(off int64)
	synced    bool
}

func newMem(size int64) *memDevice { return &memDevice{data: make([]byte, size), corruptAt: -1} }

func (m *memDevice) WriteAt(p []byte, off int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if off%Align != 0 || (len(p)%Align != 0 && off+int64(len(p)) != int64(len(m.data))) {
		return 0, errors.New("unaligned transfer")
	}
	if off+int64(len(p)) > int64(len(m.data)) {
		return 0, errors.New("write past end of device")
	}
	m.writes = append(m.writes, [2]int64{off, int64(len(p))})
	copy(m.data[off:], p)
	if m.onWrite != nil {
		m.onWrite(off)
	}
	return len(p), nil
}

func (m *memDevice) ReadAt(p []byte, off int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := copy(p, m.data[off:])
	if m.corruptAt >= off && m.corruptAt < off+int64(n) {
		p[m.corruptAt-off] ^= 0xff
	}
	return n, nil
}

func (m *memDevice) Sync() error { m.synced = true; return nil }

func memTarget(m *memDevice) *target {
	return &target{dev: m, size: int64(len(m.data)), dropCache: func() error { return nil }, finish: func(bool) error { return nil }}
}

func randomISO(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

type events struct{ buf bytes.Buffer }

func (e *events) list(t *testing.T) []map[string]any {
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(e.buf.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad event line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestCopyVerifyAlignedAndPadded(t *testing.T) {
	// 9 MiB + 2048: two full chunks, then a 1 MiB + 2048 tail padded to 4096.
	iso := randomISO(t, 2*ChunkSize+1<<20+2048)
	dev := newMem(64 << 20)
	copy(dev.data[len(iso):], bytes.Repeat([]byte{0xAA}, 8192)) // old content after the image
	var ev events
	ok, err := copyVerify(context.Background(), bytes.NewReader(iso), int64(len(iso)), int64(len(dev.data)), memTarget(dev), true, protocol.NewEmitter(&ev.buf))
	if err != nil || !ok {
		t.Fatalf("copyVerify: %v %v", ok, err)
	}
	if !dev.synced {
		t.Fatal("no fsync before read-back")
	}
	if !bytes.Equal(dev.data[:len(iso)], iso) {
		t.Fatal("device content differs from ISO")
	}
	last := dev.writes[len(dev.writes)-1]
	if last[1] != 1<<20+4096 {
		t.Fatalf("tail write %v, want padded to 4096", last)
	}
	if !bytes.Equal(dev.data[len(iso):len(iso)+2048], make([]byte, 2048)) {
		t.Fatal("padding is not zero")
	}
	evs := ev.list(t)
	final := evs[len(evs)-1]
	if final["phase"] != "verify" || final["current"].(float64) != float64(len(iso)) || final["total"].(float64) != float64(len(iso)) || final["unit"] != "bytes" {
		t.Fatalf("final event %v", final)
	}
	sawWrite := false
	for _, e := range evs {
		sawWrite = sawWrite || (e["phase"] == "write" && e["current"].(float64) == float64(len(iso)))
	}
	if !sawWrite {
		t.Fatal("no completed write progress event")
	}
}

func TestCopyVerifyPadNeverPastDeviceEnd(t *testing.T) {
	iso := randomISO(t, 6000)
	dev := newMem(6144) // device end is not 4096-aligned past the image
	if _, err := copyVerify(context.Background(), bytes.NewReader(iso), int64(len(iso)), int64(len(dev.data)), memTarget(dev), true, protocol.NewEmitter(&bytes.Buffer{})); err != nil {
		t.Fatal(err)
	}
	if w := dev.writes[0]; w[0] != 0 || w[1] != 6144 {
		t.Fatalf("write %v", w)
	}
}

func TestCopyVerifyMismatch(t *testing.T) {
	iso := randomISO(t, ChunkSize+100)
	dev := newMem(16 << 20)
	dev.corruptAt = ChunkSize + 7
	_, err := copyVerify(context.Background(), bytes.NewReader(iso), int64(len(iso)), int64(len(dev.data)), memTarget(dev), true, protocol.NewEmitter(&bytes.Buffer{}))
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindVerifyMismatch {
		t.Fatalf("got %v", err)
	}
}

func TestCopyNoVerify(t *testing.T) {
	iso := randomISO(t, 10000)
	dev := newMem(1 << 20)
	dev.corruptAt = 5
	ok, err := copyVerify(context.Background(), bytes.NewReader(iso), int64(len(iso)), int64(len(dev.data)), memTarget(dev), false, protocol.NewEmitter(&bytes.Buffer{}))
	if err != nil || ok {
		t.Fatalf("no-verify: verified=%v err=%v", ok, err)
	}
}

func TestCopyCancel(t *testing.T) {
	iso := randomISO(t, 5*ChunkSize)
	dev := newMem(32 << 20)
	ctx, cancel := context.WithCancel(context.Background())
	dev.onWrite = func(off int64) {
		if off >= ChunkSize {
			cancel()
		}
	}
	_, err := copyVerify(ctx, bytes.NewReader(iso), int64(len(iso)), int64(len(dev.data)), memTarget(dev), true, protocol.NewEmitter(&bytes.Buffer{}))
	if protocol.ExitCode(err) != protocol.ExitCancelled {
		t.Fatalf("got %v", err)
	}
	if len(dev.writes) != 2 {
		t.Fatalf("kept writing after cancel: %d writes", len(dev.writes))
	}
}
