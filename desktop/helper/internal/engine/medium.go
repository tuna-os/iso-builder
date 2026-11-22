// Package engine drives the two tacklebox engines the helper ships: the
// ISO builder (cmd/purebuild, Build) and the installer-cell fetcher
// (cmd/tacklebox write-medium, FetchMedium).
package engine

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// WriteMediumBinaryName is the cell-fetch engine's name beside the helper.
// It is built from the tacklebox feat/write-medium branch (tuna-os/tacklebox
// #512) with `go run ./cmd/build-engine -pkg ./cmd/tacklebox` until that PR
// merges and both pins move together.
const WriteMediumBinaryName = "tunaos-media-write-medium"

// EnvWriteMedium overrides the write-medium engine location (tests,
// development).
const EnvWriteMedium = "TUNAOS_MEDIA_WRITE_MEDIUM"

// LocateWriteMedium finds the write-medium engine: $TUNAOS_MEDIA_WRITE_MEDIUM,
// then next to the helper executable, then PATH.
func LocateWriteMedium() (string, error) {
	return locate(WriteMediumBinaryName, EnvWriteMedium, "The installer-image fetcher that comes with this app is missing. Please reinstall TunaOS Media Writer.")
}

// MediumOptions configures one cell fetch.
type MediumOptions struct {
	Engine string // write-medium engine executable
	Cell   string // installer cell: registry ref or OCI layout directory
	Out    string // staged image file (in the app cache dir; --resume reuses it)
	// Resume keeps the target and skips chunks that already hash correctly.
	Resume     bool
	LayoutName string // ref name for layouts with several manifests
	Emitter    *protocol.Emitter
	Stderr     io.Writer // engine console output is mirrored here
}

// MediumResult is the `done` event payload of `medium`.
type MediumResult struct {
	Path     string `json:"path"`
	Bytes    int64  `json:"bytes"`
	SHA256   string `json:"sha256"`
	Manifest string `json:"manifest"`
	Verified bool   `json:"verified"`
}

var mediumProgressRE = regexp.MustCompile(`(\d+)% \((\d+) / (\d+) MiB\)`)

// FetchMedium fetches the installer cell to Out, verifies every chunk, the
// whole stream and the read-back, and returns the digests the GUI shows
// before the user picks a stick. Signature verification is a stub in the
// engine (tuna-os/tacklebox#511): it runs with --insecure-skip-verify and
// the engine's warning is forwarded as a warn log.
func FetchMedium(ctx context.Context, o MediumOptions) (MediumResult, error) {
	out, err := filepath.Abs(o.Out)
	if err != nil {
		return MediumResult{}, protocol.Wrap(protocol.KindUsage, err, "The image file location is not valid.")
	}
	if st, err := os.Stat(filepath.Dir(out)); err != nil || !st.IsDir() {
		return MediumResult{}, protocol.Errorf(protocol.KindStorage, "The folder %s does not exist.", filepath.Dir(out))
	}
	args := []string{"write-medium", o.Cell, out, "--insecure-skip-verify"}
	if o.Resume {
		args = append(args, "--resume")
	}
	if o.LayoutName != "" {
		args = append(args, "--layout-name", o.LayoutName)
	}
	cmd := exec.CommandContext(ctx, o.Engine, args...)
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return MediumResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return MediumResult{}, err
	}
	em, track := o.Emitter, &mediumTracker{em: o.Emitter}
	if err := cmd.Start(); err != nil {
		return MediumResult{}, protocol.Wrap(protocol.KindEngine, err, "The installer-image fetcher that comes with this app could not be started. Please reinstall TunaOS Media Writer.")
	}
	mirror := o.Stderr
	if mirror == nil {
		mirror = io.Discard
	}
	var readers sync.WaitGroup
	var mu sync.Mutex
	var rawOut bytes.Buffer
	for _, r := range []io.Reader{stdout, stderr} {
		readers.Go(func() {
			scanLines(r, func(line string) {
				mu.Lock()
				fmt.Fprintln(mirror, line)
				mu.Unlock()
				if r == stdout {
					rawOut.WriteString(line + "\n")
				}
				track.line(line)
			})
		})
	}
	em.Progress(protocol.PhaseDownload, protocol.UnitBytes, 0, 0, "Fetching installer image")
	readers.Wait()
	waitErr := cmd.Wait()
	if waitErr != nil || ctx.Err() != nil {
		if ctx.Err() != nil {
			return MediumResult{}, protocol.Cancelled
		}
		return MediumResult{}, classifyMediumFailure(track.lastLine, waitErr)
	}
	res, err := parseMediumSummary(rawOut.String())
	if err != nil {
		return MediumResult{}, protocol.Wrap(protocol.KindEngine, err, "The installer-image fetcher finished without a summary. Details hold the engine output.")
	}
	res.Path = out
	res.Verified = true
	return res, nil
}

// mediumTracker turns the engine's stderr progress into protocol events.
type mediumTracker struct {
	em       *protocol.Emitter
	last     string
	lastLine string
	sent     bool
}

func (t *mediumTracker) line(raw string) {
	line := strings.TrimSpace(raw)
	if line == "" {
		return
	}
	t.lastLine = line
	if strings.HasPrefix(line, "WARNING:") {
		t.em.Warn("%s", strings.TrimSpace(strings.TrimPrefix(line, "WARNING:")))
		return
	}
	m := mediumProgressRE.FindStringSubmatch(line)
	if m == nil {
		return
	}
	done, _ := strconv.ParseInt(m[2], 10, 64)
	total, _ := strconv.ParseInt(m[3], 10, 64)
	key := m[2] + "/" + m[3]
	if key == t.last && t.sent {
		return
	}
	t.last, t.sent = key, true
	t.em.Progress(protocol.PhaseDownload, protocol.UnitBytes, done<<20, total<<20, "Fetching installer image")
}

// parseMediumSummary reads the engine's stdout summary:
//
//	wrote 6291456 bytes to /tmp/cell.img
//	manifest sha256:5d1e...
//	sha256 6cbf... (read back and verified)
//	chunks written 6, skipped 0
func parseMediumSummary(stdout string) (MediumResult, error) {
	var res MediumResult
	for line := range strings.Lines(strings.TrimSpace(stdout)) {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "wrote "):
			var n int64
			if _, err := fmt.Sscanf(line, "wrote %d bytes to", &n); err != nil || n <= 0 {
				return MediumResult{}, fmt.Errorf("bad summary line %q", line)
			}
			res.Bytes = n
		case strings.HasPrefix(line, "manifest "):
			res.Manifest = strings.TrimSpace(strings.TrimPrefix(line, "manifest"))
		case strings.HasPrefix(line, "sha256 "):
			res.SHA256 = strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "sha256")), " (read back and verified)")
		}
	}
	if res.Bytes <= 0 || res.SHA256 == "" || res.Manifest == "" {
		return MediumResult{}, fmt.Errorf("incomplete summary:\n%s", stdout)
	}
	return res, nil
}

// classifyMediumFailure maps the engine's last line to a protocol error.
func classifyMediumFailure(last string, err error) *protocol.Error {
	l := strings.ToLower(last)
	for _, s := range []string{"no such host", "connection refused", "connection reset", "timeout", "tls", "429", " 5"} {
		if strings.Contains(l, s) {
			return &protocol.Error{Kind: protocol.KindNetwork, Message: "Could not reach the image registry. Check the network and try again.", Err: err}
		}
	}
	if strings.Contains(l, "refusing to write target") {
		return &protocol.Error{Kind: protocol.KindStorage, Message: "The staged image file cannot be reused. Delete it and try again.", Err: err}
	}
	if strings.Contains(l, "not an installer image") || strings.Contains(l, "digest mismatch") || strings.Contains(l, "sha256 mismatch") {
		return &protocol.Error{Kind: protocol.KindVerifyMismatch, Message: "The downloaded image failed its integrity check. Try again.", Err: err}
	}
	return &protocol.Error{Kind: protocol.KindEngine, Message: "Fetching the installer image failed. Details hold the engine output.", Err: err}
}
