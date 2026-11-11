// Package engine runs the tacklebox ISO engine — tacklebox's own
// cmd/purebuild, built from the module version pinned in desktop/helper/go.mod
// and shipped beside the helper as tunaos-media-engine — on a BuildRequest v1,
// and turns its console output into protocol progress events.
//
// The engine's packages live under tacklebox/internal and cannot be imported
// from this module, so the helper drives the same entry point the website's
// documented fallback (`purebuild --request build-request.json`) uses.
package engine

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// BinaryName is the engine executable's name beside the helper.
const BinaryName = "tunaos-media-engine"

// EnvEngine overrides the engine location (tests, development).
const EnvEngine = "TUNAOS_MEDIA_ENGINE"

// Locate finds the engine: $TUNAOS_MEDIA_ENGINE, then next to the helper
// executable, then PATH.
func Locate() (string, error) {
	if p := os.Getenv(EnvEngine); p != "" {
		return p, nil
	}
	name := BinaryName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		p := filepath.Join(filepath.Dir(exe), name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", protocol.Errorf(protocol.KindEngine, "The image builder that comes with this app is missing. Please reinstall TunaOS Media Writer.")
}

// Options configures one build.
type Options struct {
	Engine  string // engine executable
	Request []byte // BuildRequest v1 JSON handed to the engine
	Out     string // final ISO path
	// WorkParent is the directory the per-build scratch directory is created
	// in ("" = the OS cache dir). The scratch directory is always removed.
	WorkParent string
	// CompressedSize is the catalog's compressed image size (0 = unknown);
	// it sizes the free-space check and the download progress total.
	CompressedSize int64
	Emitter        *protocol.Emitter
	Stderr         io.Writer // engine console output is mirrored here
}

// Result is the `done` event payload.
type Result struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// DefaultWorkParent is the per-user cache location for build scratch space.
func DefaultWorkParent() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "org.tunaos.MediaWriter"), nil
}

// Build runs the engine and returns the finished ISO.
func Build(ctx context.Context, o Options) (Result, error) {
	out, err := filepath.Abs(o.Out)
	if err != nil {
		return Result{}, protocol.Wrap(protocol.KindUsage, err, "The ISO file location is not valid.")
	}
	if st, err := os.Stat(filepath.Dir(out)); err != nil || !st.IsDir() {
		return Result{}, protocol.Errorf(protocol.KindStorage, "The folder %s does not exist.", filepath.Dir(out))
	}
	parent := o.WorkParent
	if parent == "" {
		if parent, err = DefaultWorkParent(); err != nil {
			return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not find a folder for temporary files.")
		}
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not create a folder for temporary files.")
	}
	if err := SpaceCheck(parent, filepath.Dir(out), o.CompressedSize); err != nil {
		return Result{}, err
	}
	work, err := os.MkdirTemp(parent, "build-")
	if err != nil {
		return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not create a folder for temporary files.")
	}
	defer os.RemoveAll(work)

	reqPath := filepath.Join(work, "build-request.json")
	if err := os.WriteFile(reqPath, o.Request, 0o644); err != nil {
		return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not write temporary files.")
	}
	partial := out + ".partial"
	_ = os.Remove(partial)
	engineWork := filepath.Join(work, "engine")

	cmd := exec.CommandContext(ctx, o.Engine, "--request", reqPath, "--out", partial, "--workdir", engineWork)
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{}, err
	}
	t := newTracker(o.Emitter, engineWork, partial, o.CompressedSize)
	t.progress(protocol.PhaseDownload, protocol.UnitSteps, 0, 0, "Starting")
	if err := cmd.Start(); err != nil {
		return Result{}, protocol.Wrap(protocol.KindEngine, err, "The image builder that comes with this app could not be started. Please reinstall TunaOS Media Writer.")
	}
	mirror := o.Stderr
	if mirror == nil {
		mirror = io.Discard
	}
	var readers sync.WaitGroup
	var mirrorMu sync.Mutex
	for _, r := range []io.Reader{stdout, stderr} {
		readers.Go(func() {
			scanLines(r, func(line string) {
				mirrorMu.Lock()
				fmt.Fprintln(mirror, line)
				mirrorMu.Unlock()
				t.line(line)
			})
		})
	}
	tickDone := make(chan struct{})
	go func() {
		tk := time.NewTicker(time.Second)
		defer tk.Stop()
		for {
			select {
			case <-tickDone:
				return
			case <-tk.C:
				t.tick()
			}
		}
	}()
	readers.Wait()
	waitErr := cmd.Wait()
	close(tickDone)
	if waitErr != nil || ctx.Err() != nil {
		_ = os.Remove(partial)
		if ctx.Err() != nil {
			return Result{}, protocol.Cancelled
		}
		kind, msg := ClassifyFailure(t.lastError())
		return Result{}, &protocol.Error{Kind: kind, Message: msg, Err: fmt.Errorf("engine: %v: %s", waitErr, t.lastError())}
	}
	st, err := os.Stat(partial)
	if err != nil {
		return Result{}, protocol.Wrap(protocol.KindEngine, err, "The image builder finished without producing an ISO file.")
	}
	sum, err := hashFile(ctx, partial, st.Size(), o.Emitter)
	if err != nil {
		_ = os.Remove(partial)
		return Result{}, err
	}
	if err := os.Rename(partial, out); err != nil {
		_ = os.Remove(partial)
		return Result{}, protocol.Wrap(protocol.KindStorage, err, "Could not save the ISO file.")
	}
	return Result{Path: out, Bytes: st.Size(), SHA256: sum}, nil
}

// scanLines splits on both \n and \r: the engine redraws "layer i/n"
// counters with carriage returns.
func scanLines(r io.Reader, fn func(string)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		if line := strings.TrimRight(sc.Text(), " \t"); strings.TrimSpace(line) != "" {
			fn(line)
		}
	}
	// A line longer than the buffer ends scanning; drain so the engine
	// never blocks on a full pipe.
	_, _ = io.Copy(io.Discard, r)
}

func hashFile(ctx context.Context, path string, size int64, em *protocol.Emitter) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", protocol.Wrap(protocol.KindStorage, err, "Could not read the finished ISO file.")
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 4<<20)
	var done int64
	last := time.Time{}
	for {
		if ctx.Err() != nil {
			return "", protocol.Cancelled
		}
		n, rerr := f.Read(buf)
		h.Write(buf[:n])
		done += int64(n)
		if time.Since(last) >= time.Second || rerr == io.EOF {
			em.Progress(protocol.PhaseIso, protocol.UnitBytes, done, size, "Checking the finished image")
			last = time.Now()
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", protocol.Wrap(protocol.KindStorage, rerr, "Could not read the finished ISO file.")
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ClassifyFailure turns the engine's last error line into a protocol kind
// and a plain-language sentence.
func ClassifyFailure(text string) (protocol.Kind, string) {
	l := strings.ToLower(text)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(l, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("no space left", "not enough space", "disk full", "there is not enough space"):
		return protocol.KindStorage, "Your computer ran out of disk space while building. Free up some space and try again."
	case has("permission denied", "access is denied", "operation not permitted"):
		return protocol.KindPermission, "The app was not allowed to write its files. Choose another folder and try again."
	case has("dial tcp", "no such host", "i/o timeout", "connection reset", "connection refused", "tls handshake",
		"network is unreachable", "unexpected eof", "http 5", "status 5", "429", "too many requests", "stalled"):
		return protocol.KindNetwork, "The download failed. Check your internet connection and try again."
	case has("mismatch", "digest"):
		return protocol.KindEngine, "The downloaded image did not match the published one. Try again later."
	}
	return protocol.KindEngine, "Building the image failed. Show details for more information."
}
