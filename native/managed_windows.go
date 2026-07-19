package main

// isManagedDrive on Windows attaches drivePath into WSL2 (same path
// executeTacklebox uses) and runs `tacklebox status` inside it. Cheaper
// than the macOS equivalent (managed_darwin.go) since there's no VM to
// boot — WSL2 is already running — but still pays the clone+build cost
// each call; no caching of the built binary across calls yet on either
// platform.
func isManagedDrive(drivePath string) (bool, string) {
	var output string
	onLine := func(line string) { output += line + "\n" }

	busID, err := findUsbipdBusID(drivePath)
	if err != nil {
		return false, ""
	}
	if err := runWindows(onLine, "usbipd", "attach", "--wsl", "--busid", busID); err != nil {
		return false, ""
	}

	guestDevice, err := findNewBlockDeviceInWSL()
	if err != nil {
		return false, ""
	}

	script := wslTackleboxCloneAndBuild + "sudo ./tacklebox status " + guestDevice + "\n"
	err = runWSLScript(script, onLine)
	return err == nil, output
}
