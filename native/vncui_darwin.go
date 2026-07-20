package main

import (
	"fmt"
	"os/exec"

	"github.com/tuna-os/iso-builder/native/vncviewer"
)

// vmViewerSupported reports whether this platform can offer the optional
// "View VM console" debugging button (main.go). True only on macOS: it's
// the only platform whose write path boots a real VM with a screen to
// look at (Linux runs tacklebox directly, Windows uses WSL2) — see
// tuna-os/iso-builder#12.
func vmViewerSupported() bool { return true }

// openVMViewer opens the bundled noVNC client in the user's default
// browser, pointed at the currently-running helper VM's VNC listener
// (see currentVNCAddr in exec_darwin.go). Returns an error if no VM is
// currently up — the button is meant to be used while a write/verify/
// update/remove operation is in progress, not standalone.
func openVMViewer() error {
	currentVNCMu.Lock()
	addr := currentVNCAddr
	currentVNCMu.Unlock()
	if addr == "" {
		return fmt.Errorf("no helper VM is currently running — start a write, verify, update, or remove first, then open the viewer while it's in progress")
	}

	url, _, err := vncviewer.Serve(addr)
	if err != nil {
		return fmt.Errorf("start VM viewer: %w", err)
	}
	// Deliberately not stopping the viewer server when this returns —
	// it's a tiny localhost-only HTTP server with negligible cost, and
	// the VM itself (and therefore anything meaningful to view) is
	// already torn down by the time the write operation's own cleanup
	// runs, at which point the browser tab just shows a disconnected
	// noVNC client rather than anything actually wrong.
	return exec.Command("open", url).Start()
}
