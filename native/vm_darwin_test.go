package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRawDeviceNode(t *testing.T) {
	cases := map[string]string{
		"/dev/disk4":          "/dev/rdisk4",
		"/dev/disk4s1":        "/dev/rdisk4s1",
		"/tmp/plain-file.img": "/tmp/plain-file.img",
		"/var/tmp/not-a-disk": "/var/tmp/not-a-disk",
	}
	for in, want := range cases {
		got, err := rawDeviceNode(in)
		if err != nil {
			t.Fatalf("rawDeviceNode(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("rawDeviceNode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFreeLocalPort(t *testing.T) {
	port, err := freeLocalPort()
	if err != nil {
		t.Fatalf("freeLocalPort: %v", err)
	}
	if port <= 0 || port > 65535 {
		t.Fatalf("freeLocalPort returned out-of-range port %d", port)
	}
}

// TestWaitForSSH_TimesOutWithNoServer confirms the polling loop actually
// gives up after `timeout` rather than hanging — using a short timeout
// against an address nothing is listening on.
func TestWaitForSSH_TimesOutWithNoServer(t *testing.T) {
	port, err := freeLocalPort()
	if err != nil {
		t.Fatalf("freeLocalPort: %v", err)
	}
	qemuExited := make(chan error)
	start := time.Now()
	_, err = waitForSSH(context.Background(), nil, port, 4*time.Second, qemuExited)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected a timeout error when nothing is listening")
	}
	if elapsed > 10*time.Second {
		t.Fatalf("waitForSSH took %s, expected it to respect the ~4s timeout", elapsed)
	}
}

// TestWaitForSSH_FailsFastOnQemuExit is the regression test for the real
// bug this session found and fixed: waitForSSH used to wait out its full
// timeout even when QEMU had already died (e.g. a port conflict on
// startup), wasting minutes of a real user's time. It must return as soon
// as qemuExited fires, well before the (deliberately long) timeout here.
func TestWaitForSSH_FailsFastOnQemuExit(t *testing.T) {
	port, err := freeLocalPort()
	if err != nil {
		t.Fatalf("freeLocalPort: %v", err)
	}
	qemuExited := make(chan error, 1)
	qemuExited <- errors.New("qemu-system-x86_64: exit status 1")

	start := time.Now()
	_, err = waitForSSH(context.Background(), nil, port, 2*time.Minute, qemuExited)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected an error once qemuExited fires")
	}
	if elapsed > 10*time.Second {
		t.Fatalf("waitForSSH took %s to notice qemuExited fired — should fail fast, not wait out the 2m timeout", elapsed)
	}
}

// TestWaitForSSH_ContextCancellation confirms cancelling the context also
// stops the loop promptly, independent of the qemuExited channel.
func TestWaitForSSH_ContextCancellation(t *testing.T) {
	port, err := freeLocalPort()
	if err != nil {
		t.Fatalf("freeLocalPort: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	qemuExited := make(chan error)

	go func() {
		time.Sleep(500 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_, err = waitForSSH(ctx, nil, port, 2*time.Minute, qemuExited)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected an error once the context is cancelled")
	}
	if elapsed > 10*time.Second {
		t.Fatalf("waitForSSH took %s to notice context cancellation", elapsed)
	}
}

func TestDownloadFile_Success(t *testing.T) {
	const body = "fake fedora cloud image bytes"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(body))
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "image.qcow2")
	if err := downloadFile(srv.URL, dest); err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading downloaded file: %v", err)
	}
	if string(got) != body {
		t.Errorf("downloaded content = %q, want %q", got, body)
	}
	// The .part staging file must not be left behind on success.
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Errorf("expected .part staging file to be gone after a successful download")
	}
}

func TestDownloadFile_HTTPErrorLeavesNoFile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "image.qcow2")
	err := downloadFile(srv.URL, dest)
	if err == nil {
		t.Fatal("expected an error on HTTP 404")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Errorf("a failed download must not leave a file at the destination path")
	}
}

func TestBuildCloudInitSeed(t *testing.T) {
	if _, err := exec.LookPath("hdiutil"); err != nil {
		t.Skip("hdiutil not on PATH — this test only runs meaningfully on a real macOS host")
	}
	dir := t.TempDir()
	seedISO := filepath.Join(dir, "seed.iso")
	const key = "ssh-ed25519 AAAAtestkeyfixture testing"

	if err := buildCloudInitSeed(dir, seedISO, key); err != nil {
		t.Fatalf("buildCloudInitSeed: %v", err)
	}
	info, err := os.Stat(seedISO)
	if err != nil {
		t.Fatalf("expected a seed ISO to be created: %v", err)
	}
	if info.Size() == 0 {
		t.Error("seed ISO is empty")
	}

	userData, err := os.ReadFile(filepath.Join(dir, "seed", "user-data"))
	if err != nil {
		t.Fatalf("reading user-data: %v", err)
	}
	if !strings.Contains(string(userData), key) {
		t.Errorf("user-data does not contain the authorized key: %s", userData)
	}
}
