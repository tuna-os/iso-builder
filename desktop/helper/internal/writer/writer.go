// Package writer writes an ISO raw to a USB drive and verifies it by reading
// it back: 4 MiB aligned writes, fsync, cache drop, SHA-256 comparison.
package writer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/drives"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

const (
	// ChunkSize is the write and read-back unit.
	ChunkSize = 4 << 20
	// Align is the I/O size granularity: raw devices (/dev/rdisk*,
	// \\.\PhysicalDrive*) reject transfers that are not whole sectors, so
	// the final partial chunk is zero-padded to a multiple of 4096 (which
	// covers 512- and 4096-byte sectors).
	Align = 4096
	// progressEvery throttles progress events.
	progressEvery = 250 * time.Millisecond
)

// Device is an opened write target.
type Device interface {
	io.WriterAt
	io.ReaderAt
	Sync() error
}

// target is an opened, prepared device plus its OS-specific hooks.
type target struct {
	dev Device
	// size is the device capacity in bytes.
	size int64
	// dropCache makes the following reads come from the medium.
	dropCache func() error
	// finish releases the device; eject requests ejection afterwards.
	finish func(eject bool) error
}

// Options configures one write.
type Options struct {
	ISO    string
	Device drives.Drive
	// FD is an inherited, already-open writable (and readable, for verify)
	// descriptor for Device (Linux Flatpak via udisks2); -1 = open the path.
	FD      int
	Verify  bool
	Emitter *protocol.Emitter
}

// Result is the protocol `done` event of `write`.
type Result struct {
	Event    string `json:"event"`
	Device   string `json:"device"`
	Bytes    int64  `json:"bytes"`
	Verified bool   `json:"verified"`
}

// Run writes and (optionally) verifies.
func Run(ctx context.Context, o Options) (Result, error) {
	iso, err := os.Open(o.ISO)
	if err != nil {
		return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not open the ISO file.")
	}
	defer iso.Close()
	st, err := iso.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() == 0 {
		return Result{}, protocol.Errorf(protocol.KindUsage, "%s is not an ISO file.", o.ISO)
	}
	size := st.Size()
	if size > o.Device.SizeBytes {
		return Result{}, &protocol.Error{
			Kind:    protocol.KindStorage,
			Message: fmt.Sprintf("This USB drive is too small: the image needs %.1f GB but the drive holds %.1f GB.", float64(size)/1e9, float64(o.Device.SizeBytes)/1e9),
			Extra:   map[string]any{"requiredBytes": size, "availableBytes": o.Device.SizeBytes},
		}
	}
	t, err := open(o.Device, o.FD)
	if err != nil {
		return Result{}, err
	}
	finished := false
	defer func() {
		if !finished {
			_ = t.finish(false)
		}
	}()
	if t.size > 0 && size > t.size {
		return Result{}, protocol.Errorf(protocol.KindDeviceChanged, "The USB drive reports less space than expected. Choose it again.")
	}
	limit := t.size
	if limit <= 0 {
		limit = o.Device.SizeBytes
	}
	verified, err := copyVerify(ctx, iso, size, limit, t, o.Verify, o.Emitter)
	if err != nil {
		return Result{}, err
	}
	finished = true
	if err := t.finish(true); err != nil {
		o.Emitter.Warn("The USB drive was written but could not be ejected automatically: %v", err)
	}
	return Result{Event: "done", Device: o.Device.Path, Bytes: size, Verified: verified}, nil
}

func roundUp(n, to int64) int64 { return (n + to - 1) / to * to }

// ioLen is the aligned transfer length for n payload bytes at off, never past
// the device end.
func ioLen(n, off, limit int64) int64 {
	l := roundUp(n, Align)
	if limit > 0 && off+l > limit {
		l = limit - off
	}
	return l
}

func copyVerify(ctx context.Context, iso io.ReaderAt, size, limit int64, t *target, verify bool, em *protocol.Emitter) (bool, error) {
	buf := make([]byte, ChunkSize)
	want := sha256.New()
	last := time.Time{}
	report := func(phase string, done int64, msg string) {
		if done == size || time.Since(last) >= progressEvery {
			em.Progress(phase, protocol.UnitBytes, done, size, msg)
			last = time.Now()
		}
	}
	report(protocol.PhaseWrite, 0, "Writing to the USB drive")
	for off := int64(0); off < size; {
		if ctx.Err() != nil {
			return false, protocol.Cancelled
		}
		n := min(int64(ChunkSize), size-off)
		if _, err := iso.ReadAt(buf[:n], off); err != nil && err != io.EOF {
			return false, protocol.Wrap(protocol.KindStorage, err, "Could not read the ISO file.")
		}
		want.Write(buf[:n])
		l := ioLen(n, off, limit)
		clear(buf[n:l])
		if _, err := t.dev.WriteAt(buf[:l], off); err != nil {
			return false, writeErr(err)
		}
		off += n
		report(protocol.PhaseWrite, off, "Writing to the USB drive")
	}
	if err := t.dev.Sync(); err != nil {
		return false, writeErr(err)
	}
	if !verify {
		return false, nil
	}
	if err := t.dropCache(); err != nil {
		em.Warn("Could not bypass the read cache before checking: %v", err)
	}
	got := sha256.New()
	last = time.Time{}
	report(protocol.PhaseVerify, 0, "Checking the USB drive")
	for off := int64(0); off < size; {
		if ctx.Err() != nil {
			return false, protocol.Cancelled
		}
		n := min(int64(ChunkSize), size-off)
		l := ioLen(n, off, limit)
		if m, err := t.dev.ReadAt(buf[:l], off); int64(m) < n {
			return false, protocol.Wrap(protocol.KindVerifyMismatch, fmt.Errorf("read %d of %d bytes at %d: %v", m, n, off, err), "The USB drive could not be read back. It may be faulty; try another one.")
		}
		got.Write(buf[:n])
		off += n
		report(protocol.PhaseVerify, off, "Checking the USB drive")
	}
	w, g := want.Sum(nil), got.Sum(nil)
	if !bytes.Equal(w, g) {
		return false, &protocol.Error{
			Kind:    protocol.KindVerifyMismatch,
			Message: "The USB drive did not read back what was written. It may be faulty; try another one.",
			Err:     fmt.Errorf("sha256 written %s, read back %s", hex.EncodeToString(w), hex.EncodeToString(g)),
		}
	}
	return true, nil
}

func writeErr(err error) error {
	if os.IsPermission(err) {
		return protocol.Wrap(protocol.KindPermission, err, "The app was not allowed to write to the USB drive.")
	}
	return protocol.Wrap(protocol.KindStorage, err, "Writing to the USB drive failed. It may have been removed or be faulty.")
}

// openTestFile opens a file-backed test device (testdevices builds only).
func openTestFile(path string) (*target, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, protocol.Wrap(protocol.KindPermission, err, "Could not open the test device.")
	}
	size, err := drives.FileSize(f)
	if err != nil {
		f.Close()
		return nil, protocol.Wrap(protocol.KindStorage, err, "Could not size the test device.")
	}
	return &target{dev: f, size: size, dropCache: func() error { return nil }, finish: func(bool) error { return f.Close() }}, nil
}
