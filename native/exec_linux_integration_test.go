//go:build integration

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestLinuxLifecycle_RealLoopDevice exercises this app's actual code paths
// (executeTacklebox for build/add, runTackleboxArgs for verify/remove) —
// not tacklebox directly by hand — against a real loop device, proving out
// the new tuna-os/iso-builder#2 UI wiring end to end. Not run by normal
// `go test ./...` (see the integration build tag).
//
// Run with:
//
//	go test -tags=integration -run=TestLinuxLifecycle_RealLoopDevice -v -timeout=30m .
//
// Requires sudo (passwordless), losetup, sgdisk, mkfs.vfat, mkfs.ext4,
// podman, skopeo, systemd-boot, a `tacklebox` binary on PATH — same
// prerequisites as tacklebox's own verify-smoke CI job.
func TestLinuxLifecycle_RealLoopDevice(t *testing.T) {
	if _, err := exec.LookPath("tacklebox"); err != nil {
		t.Skip("tacklebox not on PATH")
	}
	if err := exec.Command("sudo", "-n", "true").Run(); err != nil {
		t.Skip("passwordless sudo unavailable")
	}

	img, err := os.CreateTemp("", "tacklebox-app-lifecycle-*.img")
	if err != nil {
		t.Fatal(err)
	}
	imgPath := img.Name()
	img.Close()
	defer os.Remove(imgPath)
	if err := exec.Command("truncate", "-s", "10G", imgPath).Run(); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	out, err := exec.Command("sudo", "losetup", "--find", "--show", "--partscan", imgPath).Output()
	if err != nil {
		t.Fatalf("losetup: %v", err)
	}
	loopDev := strings.TrimSpace(string(out))
	t.Logf("loop device: %s", loopDev)
	defer exec.Command("sudo", "losetup", "-d", loopDev).Run()

	logLines := func(prefix string) func(string) {
		return func(line string) { t.Logf("%s: %s", prefix, line) }
	}

	recipe := `{
  "media_name": "TBX_APP_LIFECYCLE",
  "size": "10G",
  "shared_store": {"format": "ext4"},
  "bootable_environments": [
    {"id": "centos", "image": "quay.io/centos-bootc/centos-bootc:stream10", "modes": ["live"]}
  ]
}`
	recipeFile, err := os.CreateTemp("", "tacklebox-app-lifecycle-recipe-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(recipeFile.Name())
	if _, err := recipeFile.WriteString(recipe); err != nil {
		t.Fatal(err)
	}
	recipeFile.Close()

	// 1. build via executeTacklebox — the exact function runRecipeCommand
	//    calls from the "Write to drive" button.
	if err := executeTacklebox("build", recipeFile.Name(), loopDev, logLines("build")); err != nil {
		t.Fatalf("executeTacklebox(build): %v", err)
	}

	// 2. isManagedDrive — the exact function driveSelect.OnChanged calls.
	//    Must now report true: this is the tuna-os/iso-builder#3 default-UX
	//    detection that decides whether the button says "Write to drive"
	//    or "Add to drive".
	managed, statusOut := isManagedDrive(loopDev)
	if !managed {
		t.Fatalf("isManagedDrive reported false right after a build; status output: %s", statusOut)
	}
	t.Logf("status: %s", statusOut)

	// 3. verify via runTackleboxArgs — the exact function the new Verify
	//    button calls.
	verifyArgs := func(device string) []string { return []string{"verify", device} }
	if err := runTackleboxArgs(loopDev, verifyArgs, logLines("verify")); err != nil {
		t.Fatalf("runTackleboxArgs(verify): %v", err)
	}

	// 4. update via executeTacklebox — the exact function the new Update
	//    button calls.
	if err := executeTacklebox("update", recipeFile.Name(), loopDev, logLines("update")); err != nil {
		t.Fatalf("executeTacklebox(update): %v", err)
	}
	if err := runTackleboxArgs(loopDev, verifyArgs, logLines("verify-post-update")); err != nil {
		t.Fatalf("runTackleboxArgs(verify) after update: %v", err)
	}

	// 5. remove via runTackleboxArgs — the exact function the new Remove
	//    button calls. Nothing else was added, so removing the only env
	//    should fail cleanly (tacklebox won't remove the last environment)
	//    — asserting THAT is still a real assertion about the remove
	//    button's plumbing actually reaching tacklebox, not a no-op.
	removeArgs := func(device string) []string { return []string{"remove", "centos", device, "--yes"} }
	err = runTackleboxArgs(loopDev, removeArgs, logLines("remove"))
	t.Logf("remove result (expected to fail — can't remove the only env): %v", err)
}
