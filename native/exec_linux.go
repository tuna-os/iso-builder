package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
)

// tackleboxPath resolves the tacklebox binary to an absolute path: next
// to this executable first (bundled distribution), falling back to PATH
// (dev/CI use). Real bug caught in testing: returning the bare string
// "tacklebox" for the PATH-fallback case breaks under sudo, because sudo
// sanitizes its own PATH (secure_path) independently of the invoking
// shell's — a "tacklebox" that's genuinely on the calling user's PATH
// still comes back "command not found" once sudo re-execs with its own
// PATH. Resolving to an absolute path here up front sidesteps that
// entirely, since sudo doesn't need to look anything up.
func tackleboxPath() string {
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "tacklebox")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if resolved, err := exec.LookPath("tacklebox"); err == nil {
		return resolved
	}
	return "tacklebox"
}

// executeTacklebox runs `tacklebox <subcommand> --yes <recipe> <drivePath>`
// directly — Linux already has a real kernel, so no VM is needed (compare
// exec_darwin.go, which has to boot one first). Covers build/add/update,
// which all share this shape. See runTackleboxArgs for subcommands that
// don't (verify, remove, status).
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	return runTackleboxArgs(drivePath, func(device string) []string {
		return []string{subcommand, "--yes", recipePath, device}
	}, onLine)
}

// runTackleboxArgs runs `sudo tacklebox <args...>` directly with whatever
// argument shape the caller needs — verify (`verify <drive>`, no recipe)
// and remove (`remove <env-id> <drive> --yes`, an env ID instead of a
// recipe) don't fit executeTacklebox's build/add/update shape.
//
// argsForDevice takes a callback rather than a plain []string so this
// signature matches exec_darwin.go/exec_windows.go's runTackleboxArgs
// exactly — see exec_darwin.go's doc comment for why that has to be true
// (main.go isn't platform-tagged, so all three must share one signature).
// Linux doesn't need to attach anything, so drivePath already is the
// device path — argsForDevice(drivePath) is the whole story here.
func runTackleboxArgs(drivePath string, argsForDevice func(device string) []string, onLine func(string)) error {
	cmd := exec.Command("sudo", append([]string{tackleboxPath()}, argsForDevice(drivePath)...)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return err
	}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		onLine(scanner.Text())
	}

	return cmd.Wait()
}
