package main

import "fmt"

// Drive is a candidate write target, already filtered to what's safe to
// offer a non-technical user. Platform-neutral — populated by
// blockdev_linux.go or blockdev_darwin.go depending on GOOS.
type Drive struct {
	Path  string // e.g. /dev/sda or /dev/disk4
	Model string
	SizeH string // human-readable size, e.g. "32G"
	Size  int64  // bytes
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
