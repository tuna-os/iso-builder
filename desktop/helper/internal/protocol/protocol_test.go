package protocol

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEventEncoding(t *testing.T) {
	var b bytes.Buffer
	em := NewEmitter(&b)
	em.Progress(PhaseUnpack, UnitLayers, 3, 12, "Unpacking layer 3/12")
	em.Info("hello %s", "world")
	em.Warn("careful")
	em.Error(Errorf(KindDeviceChanged, "The drive changed."))
	em.Error(&Error{Kind: KindStorage, Message: "Full.", Extra: map[string]any{"requiredBytes": int64(10), "availableBytes": uint64(4)}})
	em.Error(fmt.Errorf("wrapped: %w", context.Canceled))
	em.Error(errors.New("raw"))
	want := `{"event":"progress","phase":"unpack","current":3,"total":12,"unit":"layers","message":"Unpacking layer 3/12"}
{"event":"log","level":"info","message":"hello world"}
{"event":"log","level":"warn","message":"careful"}
{"event":"error","kind":"device-changed","message":"The drive changed."}
{"event":"error","kind":"storage","message":"Full.","availableBytes":4,"requiredBytes":10}
{"event":"error","kind":"cancelled","message":"Cancelled."}
{"event":"error","kind":"engine","message":"Something went wrong. Show details for more information."}
`
	if b.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", b.String(), want)
	}
}

func TestExitCodes(t *testing.T) {
	for err, want := range map[error]int{
		nil:                               ExitOK,
		Errorf(KindUsage, "x"):            ExitUsage,
		Cancelled:                         ExitCancelled,
		context.Canceled:                  ExitCancelled,
		Errorf(KindNetwork, "x"):          ExitFailure,
		Wrap(KindVerifyMismatch, nil, ""): ExitFailure,
		errors.New("x"):                   ExitFailure,
	} {
		if got := ExitCode(err); got != want {
			t.Errorf("ExitCode(%v) = %d, want %d", err, got, want)
		}
	}
}

// Concurrent emitters appending to one --events file never interleave lines.
func TestEventsFileAppend(t *testing.T) {
	p := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(p, []byte(`{"event":"log","level":"info","message":"from the GUI"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	em, err := OpenEmitter(p, nil)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 50 {
				em.Progress(PhaseWrite, UnitBytes, int64(i), int64(j), strings.Repeat("x", 200))
			}
		}()
	}
	wg.Wait()
	em.Close()
	b, _ := os.ReadFile(p)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 401 || !strings.Contains(lines[0], "from the GUI") {
		t.Fatalf("%d lines, first %q", len(lines), lines[0])
	}
	for _, l := range lines {
		if !strings.HasPrefix(l, `{"event":`) || !strings.HasSuffix(l, "}") {
			t.Fatalf("torn line %q", l)
		}
	}
}

func TestCancelFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cancel")
	ctx, stop := CancelContext(context.Background(), p)
	defer stop()
	select {
	case <-ctx.Done():
		t.Fatal("cancelled before the file exists")
	case <-time.After(1500 * time.Millisecond):
	}
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("cancel file not noticed within the poll interval")
	}
}
