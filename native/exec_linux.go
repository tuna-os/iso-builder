package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
)

// tackleboxPath resolves the tacklebox binary: next to this executable
// first (bundled distribution), falling back to PATH (dev/CI use).
func tackleboxPath() string {
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "tacklebox")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "tacklebox"
}

// executeTacklebox runs `tacklebox <subcommand> --yes <recipe> <drivePath>`
// directly — Linux already has a real kernel, so no VM is needed (compare
// exec_darwin.go, which has to boot one first).
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	cmd := exec.Command("sudo", tackleboxPath(), subcommand, "--yes", recipePath, drivePath)
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
