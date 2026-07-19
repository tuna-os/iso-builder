package main

// isManagedDrive on Windows always reports "not managed" for now, for the
// same reason as managed_darwin.go: real detection means mounting and
// reading the ESP/STORE partitions, which means going through WSL2 first —
// a separate piece of work from getting the write path itself working.
// Known gap, not a silent omission.
func isManagedDrive(drivePath string) (bool, string) {
	return false, ""
}
