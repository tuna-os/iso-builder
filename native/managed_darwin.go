package main

import "strings"

// isManagedDrive on macOS boots the helper VM (same one executeTacklebox
// uses) and runs `tacklebox status` inside it. This is the real
// implementation — earlier this always returned false as a documented
// known gap while the write path was getting proven out first; now that
// bootHelperVM is shared, wiring status through it is a small addition.
//
// Real cost, not hidden: this pays the same ~1 minute VM-boot-and-build
// price as an actual write (see bootHelperVM's doc comment), just to
// answer "is this drive already managed". Checking a drive on macOS is not
// instant the way it is on Linux (a local exec) — that's an honest UX
// tradeoff of the VM-based architecture, not something this function can
// paper over.
func isManagedDrive(drivePath string) (bool, string) {
	var output strings.Builder
	onLine := func(line string) {
		output.WriteString(line)
		output.WriteString("\n")
	}

	client, cleanup, err := bootHelperVM(drivePath, onLine)
	if err != nil {
		return false, ""
	}
	defer cleanup()

	err = runRemote(client, tackleboxCloneAndBuild+"sudo ./tacklebox status /dev/vdc\n", onLine)
	return err == nil, output.String()
}
