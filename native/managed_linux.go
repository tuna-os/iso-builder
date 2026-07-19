package main

import "os/exec"

// isManagedDrive reports whether path already carries a tacklebox-managed
// multi-boot drive, by shelling to `tacklebox status`. Confirmed empirically
// (see native/README.md testing notes): on a blank/foreign device, `status`
// fails cleanly (can't mount a STORE partition that doesn't exist) with a
// non-zero exit code; on a real tacklebox drive it exits 0 and prints the
// installed environments.
//
// This is the detection behind tuna-os/iso-builder#3's default UX: plug in
// a drive, and the app defaults to managing what's already there (add/
// update/remove) rather than always offering to erase it. Output is
// returned even on failure so callers can surface the real reason if
// useful, but the bool is the thing to branch on.
func isManagedDrive(drivePath string) (bool, string) {
	cmd := exec.Command("sudo", tackleboxPath(), "status", drivePath)
	out, err := cmd.CombinedOutput()
	return err == nil, string(out)
}
