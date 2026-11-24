package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// fakeWriteMedium is the test stand-in for `tacklebox write-medium`: it
// writes deterministic bytes and prints the same stdout summary and stderr
// progress. Wired in engine_test.go's TestMain via FAKE_WRITE_MEDIUM.
func fakeWriteMedium() int {
	mode := os.Getenv("FAKE_WRITE_MEDIUM")
	args := os.Args[1:]
	if len(args) < 3 || args[0] != "write-medium" {
		fmt.Fprintln(os.Stderr, "usage: write-medium REF-OR-OCI-LAYOUT TARGET")
		return 2
	}
	out := args[2]
	if mode == "network" {
		fmt.Fprintln(os.Stderr, `fetch manifest: Get "https://ghcr.io/v2/": dial tcp: no such host`)
		return 1
	}
	if mode == "refuse" {
		fmt.Fprintf(os.Stderr, "Error: refusing to write target: %s is a non-empty file\n", out)
		return 1
	}
	payload := bytes.Repeat([]byte("CELL"), 1<<20) // 4 MiB
	sum := sha256.Sum256(payload)
	fmt.Fprintf(os.Stderr, "\r 50%% (%d / %d MiB)", 2, 4)
	fmt.Fprintln(os.Stderr)
	if err := os.WriteFile(out, payload, 0o644); err != nil {
		return 3
	}
	fmt.Printf("wrote %d bytes to %s\n", len(payload), out)
	fmt.Println("manifest sha256:5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735")
	fmt.Printf("sha256 %s (read back and verified)\n", hex.EncodeToString(sum[:]))
	fmt.Println("chunks written 6, skipped 0")
	return 0
}

func runFakeMedium(t *testing.T, mode string) (MediumResult, error, []map[string]any, string) {
	t.Helper()
	t.Setenv("FAKE_WRITE_MEDIUM", mode)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "cell.img")
	var ev capture
	res, err := FetchMedium(context.Background(), MediumOptions{
		Engine: exe, Cell: "/tmp/fake-cell", Out: out, Resume: mode == "resume",
		Emitter: protocol.NewEmitter(&ev),
	})
	return res, err, ev.events(t), out
}

func TestFetchMediumSuccess(t *testing.T) {
	res, err, evs, out := runFakeMedium(t, "ok")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(bytes.Repeat([]byte("CELL"), 1<<20))
	if res.Path != out || res.Bytes != 4<<20 || res.SHA256 != hex.EncodeToString(sum[:]) ||
		res.Manifest != "sha256:5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735" ||
		!res.Verified {
		t.Fatalf("result %+v", res)
	}
	phases := map[string]bool{}
	for _, e := range evs {
		if e["event"] == "progress" {
			phases[e["phase"].(string)] = true
		}
	}
	if !phases["download"] {
		t.Errorf("no download progress in %v", evs)
	}
}

func TestFetchMediumNetworkFailure(t *testing.T) {
	_, err, _, _ := runFakeMedium(t, "network")
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindNetwork {
		t.Fatalf("got %v", err)
	}
}

func TestFetchMediumRefusal(t *testing.T) {
	_, err, _, _ := runFakeMedium(t, "refuse")
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Kind != protocol.KindStorage {
		t.Fatalf("got %v", err)
	}
}

func TestParseMediumSummary(t *testing.T) {
	res, err := parseMediumSummary("wrote 6291456 bytes to /tmp/cell.img\nmanifest sha256:abc123\nsha256 def456 (read back and verified)\nchunks written 6, skipped 0\n")
	if err != nil || res.Bytes != 6291456 || res.Manifest != "sha256:abc123" || res.SHA256 != "def456" {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := parseMediumSummary("wrote it all, trust me\n"); err == nil {
		t.Fatal("garbage summary accepted")
	}
}

func TestClassifyMediumFailure(t *testing.T) {
	if got := classifyMediumFailure("digest mismatch", fmt.Errorf("x")); got.Kind != protocol.KindVerifyMismatch {
		t.Fatalf("mismatch: %v", got.Kind)
	}
	if got := classifyMediumFailure("", fmt.Errorf("x")); got.Kind != protocol.KindEngine {
		t.Fatalf("default: %v", got.Kind)
	}
}

func TestMediumProgressDedup(t *testing.T) {
	var ev capture
	tr := &mediumTracker{em: protocol.NewEmitter(&ev)}
	tr.line("\r 50% (2 / 4 MiB)")
	tr.line("\r 50% (2 / 4 MiB)")
	n := 0
	for _, l := range strings.Split(strings.TrimSpace(ev.String()), "\n") {
		if strings.Contains(l, `"event":"progress"`) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("duplicate progress emitted %d times", n)
	}
}

func TestClassifyMediumFailureIgnoresDigitsInPaths(t *testing.T) {
	e := classifyMediumFailure("Error: refusing to write target: /tmp/TestX4291/001/cell.img is a non-empty file", nil)
	if e.Kind != protocol.KindStorage {
		t.Fatalf("refusal misclassified: %v", e.Kind)
	}
	if e := classifyMediumFailure("write /tmp/a4291/cell.img: disk full", nil); e.Kind != protocol.KindEngine {
		t.Fatalf("path digits read as status: %v", e.Kind)
	}
	if e := classifyMediumFailure("fetch manifest: unexpected status 503 Service Unavailable", nil); e.Kind != protocol.KindNetwork {
		t.Fatalf("503 not network: %v", e.Kind)
	}
}
