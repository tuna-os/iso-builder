package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// TestMain doubles as a fake engine: with FAKE_ENGINE set, the test binary
// behaves like cmd/purebuild — same flags, same console output, same
// workdir files — so Build is exercised end to end without a registry.
func TestMain(m *testing.M) {
	if mode := os.Getenv("FAKE_ENGINE"); mode != "" {
		os.Exit(fakeEngine(mode))
	}
	os.Exit(m.Run())
}

func fakeEngine(mode string) int {
	fs := flag.NewFlagSet("purebuild", flag.ContinueOnError)
	req := fs.String("request", "", "")
	out := fs.String("out", "", "")
	work := fs.String("workdir", "", "")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return 2
	}
	if _, err := os.ReadFile(*req); err != nil {
		return 3
	}
	logf := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, time.Now().Format("2006/01/02 15:04:05 ")+format+"\n", a...)
	}
	_ = os.MkdirAll(filepath.Join(*work, "layerblobs"), 0o755)
	_ = os.MkdirAll(filepath.Join(*work, "blobs"), 0o755)
	logf(">>> resolving tuna-os/flounder:xfce (platform linux/amd64)")
	if mode == "network" {
		logf(`fetch manifest: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host`)
		return 1
	}
	logf(">>> unpacking 3 layers")
	for i := range 3 {
		_ = os.WriteFile(filepath.Join(*work, "layerblobs", fmt.Sprint("sha256_", i)), make([]byte, 1000), 0o644)
		_ = os.WriteFile(filepath.Join(*work, "blobs", fmt.Sprint(i)), make([]byte, 3000), 0o644)
		fmt.Printf("\r    layer %d/3", i+1)
		if mode == "hang" {
			time.Sleep(time.Hour)
		}
	}
	fmt.Println()
	fmt.Printf("\r    overlay layer 1/1")
	fmt.Println()
	logf(">>> live overlay grafted")
	logf(">>> WARNING: image preinstall.d asks for 1 flatpak(s) the live rootfs lacks: app/x//stable")
	logf(">>> authoring EROFS live root flounder-xfce.rootfs.sfs")
	_ = os.WriteFile(filepath.Join(*work, "flounder-xfce.rootfs.sfs"), make([]byte, 9000), 0o644)
	logf(">>> authoring ESP")
	_ = os.WriteFile(filepath.Join(*work, "efi.img"), make([]byte, 100), 0o644)
	logf(">>> authoring ISO")
	if err := os.WriteFile(*out, []byte("CD001 fake iso"), 0o644); err != nil {
		return 4
	}
	logf(">>> done: %s (0.0 GB)", *out)
	return 0
}

type capture struct{ bytes.Buffer }

func (c *capture) events(t *testing.T) []map[string]any {
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(c.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("event %q: %v", l, err)
		}
		out = append(out, m)
	}
	return out
}

func runFake(t *testing.T, mode string, ctx context.Context) (Result, error, []map[string]any, string, string) {
	t.Helper()
	t.Setenv("FAKE_ENGINE", mode)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	parent := filepath.Join(dir, "work")
	out := filepath.Join(dir, "out", "tunaos.iso")
	_ = os.MkdirAll(filepath.Dir(out), 0o755)
	var ev capture
	var stderr bytes.Buffer
	res, err := Build(ctx, Options{Engine: exe, Request: []byte(`{"schemaVersion":1}`), Out: out, WorkParent: parent,
		CompressedSize: 3000, Emitter: protocol.NewEmitter(&ev), Stderr: &stderr})
	return res, err, ev.events(t), parent, out
}

func TestBuildSuccess(t *testing.T) {
	res, err, evs, parent, out := runFake(t, "ok", context.Background())
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("CD001 fake iso"))
	if res.Path != out || res.Bytes != 14 || res.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("result %+v", res)
	}
	if _, err := os.Stat(out + ".partial"); !os.IsNotExist(err) {
		t.Fatal("partial file left behind")
	}
	if left, _ := os.ReadDir(parent); len(left) != 0 {
		t.Fatalf("workdir not cleaned: %v", left)
	}
	phases := map[string]bool{}
	warned := false
	for _, e := range evs {
		if e["event"] == "progress" {
			phases[e["phase"].(string)] = true
			if e["phase"] == "download" && e["unit"] == "bytes" && e["total"].(float64) != 3000 {
				t.Fatalf("download total %v", e)
			}
		}
		warned = warned || (e["event"] == "log" && e["level"] == "warn" && strings.Contains(e["message"].(string), "preinstall.d"))
	}
	for _, p := range []string{"download", "overlay", "erofs", "esp", "iso"} {
		if !phases[p] {
			t.Errorf("no %s progress in %v", p, evs)
		}
	}
	if !warned {
		t.Error("engine WARNING not forwarded as a warn log")
	}
}

func TestBuildNetworkFailure(t *testing.T) {
	_, err, _, parent, out := runFake(t, "network", context.Background())
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindNetwork || !strings.Contains(pe.Error(), "no such host") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Fatal("output exists after failure")
	}
	if left, _ := os.ReadDir(parent); len(left) != 0 {
		t.Fatalf("workdir not cleaned: %v", left)
	}
}

func TestBuildCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(1500*time.Millisecond, cancel)
	start := time.Now()
	_, err, _, parent, out := runFake(t, "hang", ctx)
	if protocol.ExitCode(err) != protocol.ExitCancelled {
		t.Fatalf("got %v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Fatal("cancel did not stop the engine promptly")
	}
	if _, err := os.Stat(out + ".partial"); !os.IsNotExist(err) {
		t.Fatal("partial file left behind")
	}
	if left, _ := os.ReadDir(parent); len(left) != 0 {
		t.Fatalf("workdir not cleaned: %v", left)
	}
}

func TestBuildRefusesWithoutSpace(t *testing.T) {
	dir := t.TempDir()
	_, err := Build(context.Background(), Options{Engine: "unused", Request: []byte("{}"), Out: filepath.Join(dir, "x.iso"),
		WorkParent: dir, CompressedSize: 1 << 55, Emitter: protocol.NewEmitter(&bytes.Buffer{})})
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindStorage || pe.Extra["requiredBytes"] == nil || pe.Extra["availableBytes"] == nil {
		t.Fatalf("got %v", err)
	}
}

func TestTrackerLines(t *testing.T) {
	var ev capture
	tr := newTracker(protocol.NewEmitter(&ev), "/w", "/o.partial", 0)
	tr.dirSize = func(string) int64 { return 0 }
	tr.fileSize = func(string) int64 { return 0 }
	for _, l := range []string{
		"2026/11/10 10:00:00 >>> resolving tuna-os/a:b (platform linux/amd64)",
		"2026/11/10 10:00:00 >>> unpacking 12 layers",
		"    layer 3/12",
		"    layer 3/12",
		"tbox: layer stalled at byte 5 (timeout); resuming, 3 attempt(s) left",
		"2026/11/10 10:09:00 fetch blob: unexpected EOF",
	} {
		tr.line(l)
	}
	evs := ev.events(t)
	want := []string{
		`{"current":0,"event":"progress","message":"Contacting the image server","phase":"download","total":0,"unit":"steps"}`,
		`{"current":0,"event":"progress","message":"Downloading","phase":"unpack","total":12,"unit":"layers"}`,
		`{"current":3,"event":"progress","message":"Downloading (part 3 of 12)","phase":"unpack","total":12,"unit":"layers"}`,
		`{"event":"log","level":"warn","message":"The download stalled and is being resumed."}`,
	}
	if len(evs) != len(want) {
		t.Fatalf("events %v", evs)
	}
	for i, e := range evs {
		b, _ := json.Marshal(e)
		if string(b) != want[i] {
			t.Errorf("event %d = %s, want %s", i, b, want[i])
		}
	}
	if tr.lastError() != "fetch blob: unexpected EOF" {
		t.Fatalf("lastError %q", tr.lastError())
	}
}

func TestClassifyFailure(t *testing.T) {
	for text, want := range map[string]protocol.Kind{
		"write /w/blobs/x: no space left on device":                    protocol.KindStorage,
		`Get "https://ghcr.io/v2/": dial tcp 1.2.3.4:443: i/o timeout`: protocol.KindNetwork,
		"open /out.iso: permission denied":                             protocol.KindPermission,
		"build request configDigest mismatch: got a, want b":           protocol.KindEngine,
		"no kernel found under /usr/lib/modules":                       protocol.KindEngine,
	} {
		if got, msg := ClassifyFailure(text); got != want || msg == "" {
			t.Errorf("%q -> %s", text, got)
		}
	}
}

func TestScanLinesSplitsCarriageReturns(t *testing.T) {
	var got []string
	scanLines(strings.NewReader("a\r    layer 1/2\r    layer 2/2\nb\n\n"), func(s string) { got = append(got, s) })
	if strings.Join(got, "|") != "a|    layer 1/2|    layer 2/2|b" {
		t.Fatalf("%q", got)
	}
}

func TestRequirement(t *testing.T) {
	w, o := Requirement(1 << 30)
	if w <= o || o < 4<<30 {
		t.Fatalf("work %d out %d", w, o)
	}
	if w2, _ := Requirement(0); w2 <= 0 {
		t.Fatal("unknown size must still require space")
	}
}
