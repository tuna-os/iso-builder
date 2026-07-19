package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestFirstExistingPath(t *testing.T) {
	tmp := t.TempDir()
	realFile := tmp + "/exists.fd"
	if err := os.WriteFile(realFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	got := firstExistingPath([]string{tmp + "/nope.fd", realFile, tmp + "/also-nope.fd"})
	if got != realFile {
		t.Errorf("firstExistingPath = %q, want %q", got, realFile)
	}
}

func TestFirstExistingPath_NoneExist(t *testing.T) {
	tmp := t.TempDir()
	got := firstExistingPath([]string{tmp + "/a.fd", tmp + "/b.fd"})
	if got != "" {
		t.Errorf("firstExistingPath = %q, want empty string", got)
	}
}

func TestWatchBootLog_Success(t *testing.T) {
	r := strings.NewReader("Booting...\nLoading kernel\nWelcome to TunaOS\nlogin: ")
	var lines []string
	err := watchBootLog(r, 5*time.Second, func(l string) { lines = append(lines, l) })
	if err != nil {
		t.Fatalf("expected success, got: %v", err)
	}
	if len(lines) == 0 {
		t.Error("expected onLine to be called with at least one line")
	}
}

func TestWatchBootLog_KernelPanic(t *testing.T) {
	r := strings.NewReader("Booting...\nKernel panic - not syncing: VFS: Unable to mount root fs\n")
	err := watchBootLog(r, 5*time.Second, func(string) {})
	if err == nil {
		t.Fatal("expected an error on kernel panic")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Errorf("error should mention the panic, got: %v", err)
	}
}

func TestWatchBootLog_TimesOutWithoutSuccessPattern(t *testing.T) {
	r := strings.NewReader("Booting...\nStill going...\n")
	start := time.Now()
	err := watchBootLog(r, 2*time.Second, func(string) {})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected a timeout error when no success pattern ever appears")
	}
	if elapsed > 8*time.Second {
		t.Fatalf("took %s, expected it to respect the ~2s timeout", elapsed)
	}
}

func TestWatchBootLog_EOFWithoutSuccessIsAnError(t *testing.T) {
	// QEMU exiting on its own (crash, unexpected shutdown) before any
	// recognizable success pattern must be a failure, not silently "done".
	r := strings.NewReader("Booting...\nQEMU: Terminated\n")
	err := watchBootLog(r, 5*time.Second, func(string) {})
	if err == nil {
		t.Fatal("expected an error when the log ends without a success pattern")
	}
}
