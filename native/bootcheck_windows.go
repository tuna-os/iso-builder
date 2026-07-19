package main

import "fmt"

// bootCheckSupported is false on Windows: the write path already runs
// inside WSL2 (see exec_windows.go), and boot-checking the raw USB device
// would mean booting a nested VM from within WSL2 — not guaranteed
// available (needs nested virtualization) and out of scope for now. See
// bootcheck_linux.go for the real implementation.
func bootCheckSupported() bool { return false }

func runBootCheck(drivePath string, onLine func(string)) error {
	return fmt.Errorf("verifying by booting isn't available on Windows yet — the write path already runs inside WSL2, and nesting a VM boot check inside that isn't supported")
}
