package main

import "fmt"

// vmViewerSupported is false on Linux: tacklebox runs directly on the
// host here, no VM involved — there's nothing to view. See
// vncui_darwin.go for the real implementation.
func vmViewerSupported() bool { return false }

func openVMViewer() error {
	return fmt.Errorf("the VM viewer isn't applicable on Linux — tacklebox runs directly here, no VM involved")
}
