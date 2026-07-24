//go:build linux && embedtacklebox

package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"os"
	"path/filepath"
)

// embeddedTacklebox is the tacklebox CLI baked into this executable, so the
// app ships as a single self-contained binary (no separate tacklebox on PATH
// or beside the app). Built only with `-tags embedtacklebox`, where the build
// pipeline has placed a matching-arch **static** (CGO_ENABLED=0) tacklebox
// binary at native/tacklebox before `go build`. Normal dev builds omit the
// tag and fall back to exec_linux.go's next-to-exe / PATH resolution.
//
//go:embed tacklebox
var embeddedTacklebox []byte

// embeddedTackleboxPath materializes the embedded binary to a stable per-user
// cache path (once per build, keyed by a content hash) and returns it. The
// hash in the name means a new app version re-extracts rather than reusing a
// stale binary, and concurrent app launches converge on the same file.
func embeddedTackleboxPath() string {
	sum := sha256.Sum256(embeddedTacklebox)
	name := "tacklebox-" + hex.EncodeToString(sum[:8])

	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	dir := filepath.Join(cache, "org.tunaos.tacklebox-app")
	dst := filepath.Join(dir, name)

	if fi, err := os.Stat(dst); err == nil && fi.Size() == int64(len(embeddedTacklebox)) {
		return dst // already extracted this exact build
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	// Write to a temp path then rename so a half-written file is never used.
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, embeddedTacklebox, 0o755); err != nil {
		return ""
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return ""
	}
	return dst
}
