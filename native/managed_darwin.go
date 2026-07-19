package main

// isManagedDrive on macOS always reports "not managed" for now: checking
// requires mounting and reading the ESP/STORE partitions, and on macOS
// that means booting the VM (exec_darwin.go) just to answer a status
// question — real, but a meaningfully separate piece of work from getting
// the actual write path working first. Tracked as a known gap, not a
// silent omission: until this is real, macOS users always see the erase
// confirmation, even on a drive they've already written with this app.
func isManagedDrive(drivePath string) (bool, string) {
	return false, ""
}
