//go:build integration

package main

import (
	"os"
	"testing"
)

// TestExecuteTacklebox_RealVM is a manual integration test — not run by
// normal `go test ./...` (see the integration build tag). It exercises
// executeTacklebox for real: boots the actual QEMU VM, attaches a raw
// disk file standing in for a physical USB drive, and runs a real
// tacklebox build inside it.
//
// Run with:
//
//	go test -tags=integration -run=TestExecuteTacklebox_RealVM -v -timeout=60m .
//
// Requires TACKLEBOX_APP_TEST_TARGET_DISK set to a raw disk file/device
// path (see native/README.md for how this was exercised by hand before
// this test existed).
func TestExecuteTacklebox_RealVM(t *testing.T) {
	target := os.Getenv("TACKLEBOX_APP_TEST_TARGET_DISK")
	if target == "" {
		t.Skip("TACKLEBOX_APP_TEST_TARGET_DISK not set")
	}

	recipe := `{
  "media_name": "TBX_APP_TEST",
  "size": "10G",
  "shared_store": {"format": "ext4"},
  "bootable_environments": [
    {"id": "centos", "image": "quay.io/centos-bootc/centos-bootc:stream10", "modes": ["live"]}
  ]
}`
	recipeFile, err := os.CreateTemp("", "tacklebox-app-test-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(recipeFile.Name())
	if _, err := recipeFile.WriteString(recipe); err != nil {
		t.Fatal(err)
	}
	recipeFile.Close()

	var lines []string
	onLine := func(l string) {
		t.Log(l)
		lines = append(lines, l)
	}

	if err := executeTacklebox("build", recipeFile.Name(), target, onLine); err != nil {
		t.Fatalf("executeTacklebox failed after %d output lines: %v", len(lines), err)
	}
}
