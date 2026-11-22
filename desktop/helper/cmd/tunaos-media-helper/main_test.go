package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/engine"
	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// With FAKE_ENGINE set the test binary stands in for tunaos-media-engine:
// it copies the request it was given and writes a tiny ISO.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_WRITE_MEDIUM") != "" {
		os.Exit(fakeWriteMedium())
	}
	if os.Getenv("FAKE_ENGINE") != "" {
		fs := flag.NewFlagSet("purebuild", flag.ExitOnError)
		req := fs.String("request", "", "")
		out := fs.String("out", "", "")
		_ = fs.String("workdir", "", "")
		_ = fs.Parse(os.Args[1:])
		b, err := os.ReadFile(*req)
		if err != nil {
			os.Exit(3)
		}
		_ = os.WriteFile(os.Getenv("FAKE_ENGINE"), b, 0o644)
		if err := os.WriteFile(*out, []byte("CD001"), 0o644); err != nil {
			os.Exit(4)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fakeWriteMedium stands in for `tacklebox write-medium`: same argv shape,
// same stdout summary, so `medium` is exercised without a registry.
func fakeWriteMedium() int {
	args := os.Args[1:]
	if len(args) < 3 || args[0] != "write-medium" {
		fmt.Fprintln(os.Stderr, "usage: write-medium REF-OR-OCI-LAYOUT TARGET")
		return 2
	}
	out := args[2]
	payload := []byte("CELL")
	sum := sha256.Sum256(payload)
	fmt.Fprintf(os.Stderr, "\r100%% (%d / %d MiB)\n", 1, 1)
	if err := os.WriteFile(out, payload, 0o644); err != nil {
		return 3
	}
	fmt.Printf("wrote %d bytes to %s\n", len(payload), out)
	fmt.Println("manifest sha256:5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735")
	fmt.Printf("sha256 %s (read back and verified)\n", hex.EncodeToString(sum[:]))
	fmt.Println("chunks written 1, skipped 0")
	return 0
}

// offline points catalog loads at a closed port so they fall back to the
// embedded copy immediately.
const offline = "http://127.0.0.1:1"

func call(t *testing.T, args ...string) (int, []map[string]any) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, &out, &errb)
	var evs []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if l == "" || !strings.HasPrefix(l, "{") {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("stdout line %q is not JSON: %v", l, err)
		}
		evs = append(evs, m)
	}
	return code, evs
}

func last(evs []map[string]any) map[string]any {
	if len(evs) == 0 {
		return nil
	}
	return evs[len(evs)-1]
}

func TestVersion(t *testing.T) {
	code, evs := call(t, "version")
	v := last(evs)
	if code != 0 || v["event"] != "version" || v["helper"] != version || v["protocol"] != float64(1) {
		t.Fatalf("%d %v", code, evs)
	}
	// The pin is a pseudo-version (v0.0.0-<time>-<sha>) or a release tag
	// (v0.1.0); both start with "v". Only the "unknown" fallback does not.
	if e, _ := v["engine"].(string); !strings.HasPrefix(e, "v") {
		t.Fatalf("engine version %q", e)
	}
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"frobnicate"},
		{"build", "--out", "x.iso"},
		{"build", "--target", "a", "--request", "b", "--out", "x.iso"},
		{"medium"},
		{"medium", "--cell", "x"},
		{"medium", "--out", "x.img"},
	} {
		code, evs := call(t, args...)
		e := last(evs)
		if code != protocol.ExitUsage || e["event"] != "error" || e["kind"] != "usage" {
			t.Errorf("%v: exit %d events %v", args, code, evs)
		}
	}
}

func TestCatalogOfflineFallback(t *testing.T) {
	code, evs := call(t, "catalog", "--base-url", offline)
	if code != 0 || len(evs) != 2 || evs[0]["level"] != "warn" || evs[1]["event"] != "catalog" {
		t.Fatalf("%d %v", code, evs)
	}
	if targets, _ := evs[1]["targets"].([]any); len(targets) == 0 {
		t.Fatal("no targets")
	}
}

func TestDrives(t *testing.T) {
	code, evs := call(t, "drives")
	if code != 0 || last(evs)["event"] != "drives" {
		t.Fatalf("%d %v", code, evs)
	}
	if _, ok := last(evs)["drives"].([]any); !ok {
		t.Fatalf("drives is not an array: %v", last(evs))
	}
}

func fakeEngine(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(engine.EnvEngine, exe)
	saved := engine.SpaceCheck
	engine.SpaceCheck = func(string, string, int64) error { return nil }
	t.Cleanup(func() { engine.SpaceCheck = saved })
	copyPath := filepath.Join(t.TempDir(), "request-seen-by-engine.json")
	t.Setenv("FAKE_ENGINE", copyPath)
	return copyPath
}

func TestBuildTarget(t *testing.T) {
	seen := fakeEngine(t)
	dir := t.TempDir()
	out := filepath.Join(dir, "tunaos.iso")
	code, evs := call(t, "build", "--target", "flounder:xfce:linux/amd64", "--out", out,
		"--workdir", filepath.Join(dir, "work"), "--flatpaks", "org.mozilla.firefox", "--base-url", offline)
	done := last(evs)
	sum := sha256.Sum256([]byte("CD001"))
	if code != 0 || done["event"] != "done" || done["path"] != out || done["bytes"] != float64(5) ||
		done["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("%d %v", code, evs)
	}
	var req map[string]any
	b, _ := os.ReadFile(seen)
	if err := json.Unmarshal(b, &req); err != nil {
		t.Fatal(err)
	}
	opts := req["options"].(map[string]any)
	if req["registry"] != "https://ghcr.io" || req["image"] != "ghcr.io/tuna-os/flounder:xfce" ||
		len(opts["flatpaks"].([]any)) != 1 || req["customImage"] != false || req["resolvedInputs"] == nil {
		t.Fatalf("engine got %s", b)
	}
	if left, _ := os.ReadDir(filepath.Join(dir, "work")); len(left) != 0 {
		t.Fatalf("workdir not cleaned: %v", left)
	}
}

func TestBuildRequestFile(t *testing.T) {
	seen := fakeEngine(t)
	dir := t.TempDir()
	reqPath := filepath.Join(dir, "build-request.json")
	browser := `{"schemaVersion":1,"kind":"build-request","customImage":true,"image":"ghcr.io/tuna-os/flounder:xfce","registry":"https://relay.tunaos.org","options":{"label":"TUNAOS","packages":[],"flatpaks":["org.mozilla.firefox"],"extraRun":[],"outputFilename":"x.iso"},"catalogVersion":""}`
	if err := os.WriteFile(reqPath, []byte(browser), 0o644); err != nil {
		t.Fatal(err)
	}
	code, evs := call(t, "build", "--request", reqPath, "--out", filepath.Join(dir, "x.iso"),
		"--workdir", dir, "--flatpaks", "none", "--base-url", offline)
	if code != 0 || last(evs)["event"] != "done" {
		t.Fatalf("%d %v", code, evs)
	}
	b, _ := os.ReadFile(seen)
	var req map[string]any
	_ = json.Unmarshal(b, &req)
	if req["registry"] != "https://ghcr.io" || len(req["options"].(map[string]any)["flatpaks"].([]any)) != 0 {
		t.Fatalf("engine got %s", b)
	}
}

// fakeWriteMediumExe points the medium subcommand at this test binary.
func fakeWriteMediumExe(t *testing.T) {
	t.Helper()
	t.Setenv("FAKE_WRITE_MEDIUM", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TUNAOS_MEDIA_WRITE_MEDIUM", exe)
}

func TestMediumStagesCell(t *testing.T) {
	fakeWriteMediumExe(t)
	dir := t.TempDir()
	out := filepath.Join(dir, "cell.img")
	code, evs := call(t, "medium", "--cell", "/tmp/fake-cell", "--out", out)
	done := last(evs)
	sum := sha256.Sum256([]byte("CELL"))
	if code != 0 || done["event"] != "done" || done["path"] != out || done["bytes"] != float64(4) ||
		done["sha256"] != hex.EncodeToString(sum[:]) ||
		done["manifest"] != "sha256:5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735" ||
		done["verified"] != true {
		t.Fatalf("%d %v", code, evs)
	}
}

func TestBuildRequestWithCellStagesInsteadOfBuilding(t *testing.T) {
	fakeWriteMediumExe(t)
	seen := fakeEngine(t)
	dir := t.TempDir()
	reqPath := filepath.Join(dir, "build-request.json")
	withCell := `{"schemaVersion":1,"kind":"build-request","customImage":true,"image":"ghcr.io/tuna-os/flounder:xfce","registry":"https://relay.tunaos.org","options":{"label":"TUNAOS","packages":[],"flatpaks":[],"extraRun":[],"outputFilename":"x.iso"},"catalogVersion":"","cell":"/tmp/fake-cell"}`
	if err := os.WriteFile(reqPath, []byte(withCell), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "cell.img")
	code, evs := call(t, "build", "--request", reqPath, "--out", out, "--workdir", dir, "--base-url", offline)
	if code != 0 || last(evs)["event"] != "done" {
		t.Fatalf("%d %v", code, evs)
	}
	if _, err := os.Stat(seen); !os.IsNotExist(err) {
		t.Fatal("cell request reached the ISO builder")
	}
}

func TestBuildUnknownTarget(t *testing.T) {
	fakeEngine(t)
	code, evs := call(t, "build", "--target", "nope:nope:linux/amd64", "--out", filepath.Join(t.TempDir(), "x.iso"), "--base-url", offline)
	if code != protocol.ExitUsage || last(evs)["kind"] != "usage" {
		t.Fatalf("%d %v", code, evs)
	}
}

func TestEventsFileAndPreCancelled(t *testing.T) {
	dir := t.TempDir()
	events := filepath.Join(dir, "events.jsonl")
	cancel := filepath.Join(dir, "cancel")
	_ = os.WriteFile(cancel, nil, 0o644)
	fakeEngine(t)
	code, stdout := call(t, "build", "--target", "flounder:xfce:linux/amd64", "--out", filepath.Join(dir, "x.iso"),
		"--base-url", offline, "--events", events, "--cancel-file", cancel)
	if len(stdout) != 0 {
		t.Fatalf("events leaked to stdout with --events: %v", stdout)
	}
	b, _ := os.ReadFile(events)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	var e map[string]any
	_ = json.Unmarshal([]byte(lines[len(lines)-1]), &e)
	if code != protocol.ExitCancelled || e["kind"] != "cancelled" {
		t.Fatalf("exit %d, events:\n%s", code, b)
	}
}
