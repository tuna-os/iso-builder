// Command build-engine builds the tacklebox engine the helper runs
// (tunaos-media-engine) from the exact tacklebox version pinned in
// desktop/helper/go.mod.
//
//	cd desktop/helper
//	go run ./cmd/build-engine -goos darwin -goarch arm64 -o DIR/tunaos-media-engine
//
// Pass the target with -goos/-goarch, not GOOS/GOARCH in the environment
// (that would cross-compile this tool itself, which then cannot run).
//
// The engine is tacklebox's cmd/purebuild, built — like the website's
// tbox.wasm (ci.yml `wasm`) — inside tacklebox's own module at the pinned
// version, so its dependencies are exactly tacklebox's go.sum. The module
// comes from the Go module cache (hash-verified against desktop/helper/go.sum)
// and is copied to a scratch directory, because at the pinned version
// purebuild declares punchReader only for Linux: punch_other.go.txt (a plain
// reader, //go:build !linux) is added to the copy so macOS and Windows build.
// No tacklebox source file is changed.
package main

import (
	_ "embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed punch_other.go.txt
var punchOther []byte

const enginePkg = "./cmd/purebuild"

func main() {
	out := flag.String("o", "", "output path for the engine binary (required)")
	goos := flag.String("goos", "", "target GOOS (default: host)")
	goarch := flag.String("goarch", "", "target GOARCH (default: host)")
	flag.Parse()
	if *out == "" || flag.NArg() != 0 {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*out, *goos, *goarch); err != nil {
		fmt.Fprintln(os.Stderr, "build-engine:", err)
		os.Exit(1)
	}
}

func run(out, goos, goarch string) error {
	out, err := filepath.Abs(out)
	if err != nil {
		return err
	}
	if b, err := exec.Command("go", "mod", "download", "github.com/tuna-os/tacklebox").CombinedOutput(); err != nil {
		return fmt.Errorf("download pinned tacklebox module: %v: %s", err, b)
	}
	dirOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/tuna-os/tacklebox").Output()
	if err != nil {
		return fmt.Errorf("locate pinned tacklebox module: %w", err)
	}
	modDir := strings.TrimSpace(string(dirOut))
	if modDir == "" {
		return fmt.Errorf("pinned tacklebox module is not in the module cache")
	}
	tmp, err := os.MkdirTemp("", "build-engine-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	src := filepath.Join(tmp, "tacklebox")
	if err := copyTree(modDir, src); err != nil {
		return fmt.Errorf("copy tacklebox module: %w", err)
	}
	if err := os.WriteFile(filepath.Join(src, "cmd", "purebuild", "punch_other.go"), punchOther, 0o644); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, enginePkg)
	cmd.Dir = src
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOWORK=off", "GOFLAGS=-mod=readonly")
	if goos != "" {
		cmd.Env = append(cmd.Env, "GOOS="+goos)
	}
	if goarch != "" {
		cmd.Env = append(cmd.Env, "GOARCH="+goarch)
	}
	return cmd.Run()
}

// copyTree copies a module-cache directory (read-only files) into dst with
// writable permissions.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}
