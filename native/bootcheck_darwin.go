package main

import "fmt"

// bootCheckSupported is false on macOS: the write path already runs inside
// a QEMU/TCG helper VM (see exec_darwin.go), and boot-checking would mean
// nesting a second QEMU boot inside that VM — nested virtualization isn't
// guaranteed available and would be markedly slower even where it is. See
// bootcheck_linux.go for the real implementation.
func bootCheckSupported() bool { return false }

func runBootCheck(drivePath string, onLine func(string)) error {
	return fmt.Errorf("verifying by booting isn't available on macOS yet — the write path already runs inside a helper VM, and nesting a second one isn't supported")
}
