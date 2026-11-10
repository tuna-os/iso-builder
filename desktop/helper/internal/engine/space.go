package engine

import (
	"fmt"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/protocol"
)

// Disk model of one build, from the engine's layout (cmd/purebuild):
// the workdir holds the unpacked tree (U) plus the retained compressed layers
// (C) that become the ISO's offline install source; the EROFS pass consumes
// the tree while writing the live root (≈U), so the workdir peaks near U+C;
// the ISO is the live root plus the layers (≈U+C) and is written while the
// workdir still holds both.
const (
	// ExpandRatio is unpacked/compressed size for TunaOS images
	// (calibrated against a real build; see desktop/README.md).
	ExpandRatio = 3.0
	// UnknownCompressed is assumed when a request's size is not in the catalog.
	UnknownCompressed = int64(2500) << 20
	slackWork         = int64(1) << 30
	slackOut          = int64(256) << 20
)

// Requirement returns the bytes needed in the workdir and for the ISO.
func Requirement(compressed int64) (work, out int64) {
	if compressed <= 0 {
		compressed = UnknownCompressed
	}
	tree := int64(float64(compressed) * ExpandRatio)
	return tree + compressed + slackWork, tree + compressed + slackOut
}

// SpaceCheck is the free-space preflight Build runs; tests of callers that
// use a fake engine replace it so they do not depend on the host's disk.
var SpaceCheck = CheckSpace

// CheckSpace fails with a `storage` error when the work and output
// locations cannot hold the build.
func CheckSpace(workDir, outDir string, compressed int64) error {
	work, out := Requirement(compressed)
	check := func(dir string, need int64) error {
		free, err := freeBytes(dir)
		if err != nil {
			return nil // unknown: let the build try rather than refuse
		}
		if free >= uint64(need) {
			return nil
		}
		return &protocol.Error{
			Kind: protocol.KindStorage,
			Message: fmt.Sprintf("Not enough free disk space: this needs about %.1f GB but only %.1f GB is free. Free up some space and try again.",
				float64(need)/1e9, float64(free)/1e9),
			Extra: map[string]any{"requiredBytes": need, "availableBytes": free, "path": dir},
		}
	}
	if sameVolume(workDir, outDir) {
		return check(workDir, work+out)
	}
	if err := check(workDir, work); err != nil {
		return err
	}
	return check(outDir, out)
}
