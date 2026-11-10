package engine

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// The engine's console contract (tacklebox cmd/purebuild main.go):
//
//	2026/11/10 12:00:00 >>> resolving tuna-os/x:y (platform linux/amd64)
//	2026/11/10 12:00:01 >>> unpacking 65 layers
//	\r    layer 3/65                      (stdout, redrawn)
//	\r    overlay layer 1/2               (stdout, redrawn)
//	... >>> authoring EROFS live root x.rootfs.sfs
//	... >>> authoring ESP
//	... >>> authoring ISO
//	... >>> done: /path (4.2 GB)
//	2026/11/10 12:09:00 <error>           (log.Fatal, exit 1)
var (
	logPrefixRE = regexp.MustCompile(`^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2} `)
	layerRE     = regexp.MustCompile(`^\s*layer (\d+)/(\d+)$`)
	overlayRE   = regexp.MustCompile(`^\s*overlay layer (\d+)/(\d+)$`)
)

const (
	stageStart    = ""
	stageDownload = "download"
	stageOverlay  = "overlay"
	stageErofs    = "erofs"
	stageEsp      = "esp"
	stageIso      = "iso"
)

// tracker maps engine console lines and workdir sizes to progress events.
type tracker struct {
	mu         sync.Mutex
	em         *protocol.Emitter
	work       string // engine --workdir
	partial    string // engine --out
	compressed int64

	stage         string
	layer, layers int
	erofsTotal    int64
	isoTotal      int64
	lastErr       string
	lastSent      protocol.ProgressEvent

	fileSize func(string) int64
	dirSize  func(string) int64
}

func newTracker(em *protocol.Emitter, work, partial string, compressed int64) *tracker {
	return &tracker{em: em, work: work, partial: partial, compressed: compressed, fileSize: fileSize, dirSize: dirSize}
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

func (t *tracker) sfsSize() int64 {
	matches, _ := filepath.Glob(filepath.Join(t.work, "*.rootfs.sfs"))
	var n int64
	for _, m := range matches {
		n += t.fileSize(m)
	}
	return n
}

// progress emits unless identical to the previous event.
func (t *tracker) progress(phase, unit string, cur, total int64, msg string) {
	ev := protocol.ProgressEvent{Event: "progress", Phase: phase, Current: cur, Total: total, Unit: unit, Message: msg}
	if ev == t.lastSent {
		return
	}
	t.lastSent = ev
	t.em.Emit(ev)
}

func (t *tracker) lastError() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastErr
}

func (t *tracker) downloadProgress() {
	msg := "Downloading"
	if t.layers > 0 && t.layer > 0 {
		msg = "Downloading (part " + strconv.Itoa(t.layer) + " of " + strconv.Itoa(t.layers) + ")"
	}
	if t.compressed > 0 {
		cur := t.dirSize(filepath.Join(t.work, "layerblobs"))
		if cur > t.compressed {
			cur = t.compressed
		}
		t.progress(protocol.PhaseDownload, protocol.UnitBytes, cur, t.compressed, msg)
		return
	}
	t.progress(protocol.PhaseUnpack, protocol.UnitLayers, int64(t.layer), int64(t.layers), msg)
}

// line consumes one engine console line.
func (t *tracker) line(raw string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	timestamped := logPrefixRE.MatchString(raw)
	msg := logPrefixRE.ReplaceAllString(raw, "")
	if m := layerRE.FindStringSubmatch(msg); m != nil {
		t.stage = stageDownload
		t.layer, _ = strconv.Atoi(m[1])
		t.layers, _ = strconv.Atoi(m[2])
		t.downloadProgress()
		return
	}
	if m := overlayRE.FindStringSubmatch(msg); m != nil {
		t.stage = stageOverlay
		i, _ := strconv.ParseInt(m[1], 10, 64)
		n, _ := strconv.ParseInt(m[2], 10, 64)
		t.progress(protocol.PhaseOverlay, protocol.UnitLayers, i, n, "Adding the live session settings")
		return
	}
	if strings.HasPrefix(msg, "tbox: layer") {
		t.em.Warn("The download stalled and is being resumed.")
		return
	}
	body, ok := strings.CutPrefix(msg, ">>> ")
	if !ok {
		if timestamped {
			t.lastErr = msg // log.Fatal's text is the last timestamped non->>> line
		}
		return
	}
	switch {
	case strings.HasPrefix(body, "resolving"):
		t.stage = stageDownload
		t.progress(protocol.PhaseDownload, protocol.UnitSteps, 0, 0, "Contacting the image server")
	case strings.HasPrefix(body, "unpacking "):
		t.stage = stageDownload
		if f := strings.Fields(body); len(f) >= 2 {
			t.layers, _ = strconv.Atoi(f[1])
		}
		t.downloadProgress()
	case strings.HasPrefix(body, "WARNING: "):
		t.em.Warn("%s", strings.TrimPrefix(body, "WARNING: "))
	case strings.HasPrefix(body, "authoring EROFS"):
		t.stage = stageErofs
		t.erofsTotal = t.dirSize(filepath.Join(t.work, "blobs"))
		t.progress(protocol.PhaseErofs, protocol.UnitBytes, 0, t.erofsTotal, "Building the system image")
	case strings.HasPrefix(body, "authoring ESP"):
		t.stage = stageEsp
		t.progress(protocol.PhaseEsp, protocol.UnitSteps, 0, 0, "Preparing the boot files")
	case strings.HasPrefix(body, "authoring ISO"):
		t.stage = stageIso
		t.isoTotal = t.sfsSize() + t.dirSize(filepath.Join(t.work, "layerblobs")) +
			t.fileSize(filepath.Join(t.work, "efi.img")) + 2*t.fileSize(filepath.Join(t.work, "initrd-tbox.img"))
		t.progress(protocol.PhaseIso, protocol.UnitBytes, 0, t.isoTotal, "Writing the ISO file")
	case strings.HasPrefix(body, "done:"):
	default:
		if t.stage == stageDownload || t.stage == stageOverlay {
			t.stage = stageOverlay
			t.progress(protocol.PhaseOverlay, protocol.UnitSteps, 0, 0, "Preparing the live system")
		}
	}
}

// tick refreshes byte counters from the engine's workdir (once a second).
func (t *tracker) tick() {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.stage {
	case stageDownload:
		if t.compressed > 0 && t.layers > 0 {
			t.downloadProgress()
		}
	case stageErofs:
		cur := t.sfsSize()
		if cur > t.erofsTotal {
			t.erofsTotal = cur
		}
		t.progress(protocol.PhaseErofs, protocol.UnitBytes, cur, t.erofsTotal, "Building the system image")
	case stageIso:
		cur := t.fileSize(t.partial)
		if cur > t.isoTotal {
			t.isoTotal = cur
		}
		t.progress(protocol.PhaseIso, protocol.UnitBytes, cur, t.isoTotal, "Writing the ISO file")
	}
}
