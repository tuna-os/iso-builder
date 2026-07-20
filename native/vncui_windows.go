package main

import "fmt"

// vmViewerSupported is false on Windows: the write path uses WSL2, not a
// VM with a screen to look at — there's nothing to view. See
// vncui_darwin.go for the real (macOS) implementation.
func vmViewerSupported() bool { return false }

func openVMViewer() error {
	return fmt.Errorf("the VM viewer isn't applicable on Windows — the write path uses WSL2, not a VM with a screen")
}
