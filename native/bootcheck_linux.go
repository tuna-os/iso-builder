package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Optional post-write verification (tuna-os/tacklebox#104's "Milestone 5":
// boot-gate a newly written/updated drive in a VM before calling the
// operation done). Reimplements the relevant subset of tacklebox's own
// scripts/test-boot.sh in Go rather than depending on that script being
// present at runtime — this app can't assume a tacklebox checkout exists
// on the end user's machine, only the `tacklebox` binary itself (see
// tackleboxPath()). Keep the success/failure patterns below in sync with
// test-boot.sh if that script's patterns change; this is deliberately the
// same boot-verification approach tacklebox's own CI already relies on.
//
// Linux-only for now: this runs QEMU directly against the just-written
// device on the same host, no VM-inside-a-VM problem. The macOS and
// Windows write paths already run inside a VM (QEMU/TCG) or WSL2
// respectively — nesting a second QEMU boot-check inside either would
// mean nested virtualization, which isn't guaranteed available and would
// be markedly slower; not attempted here.

var ovmfCodePaths = []string{
	"/usr/share/edk2/ovmf/OVMF_CODE.fd",
	"/usr/share/OVMF/OVMF_CODE.fd",
	"/usr/share/OVMF/OVMF_CODE_4M.fd",
	"/usr/share/edk2/x64/OVMF_CODE.fd",
}

var ovmfVarsPaths = []string{
	"/usr/share/edk2/ovmf/OVMF_VARS.fd",
	"/usr/share/OVMF/OVMF_VARS.fd",
	"/usr/share/OVMF/OVMF_VARS_4M.fd",
	"/usr/share/edk2/x64/OVMF_VARS.fd",
}

// bootCheckSuccessPatterns mirrors test-boot.sh's PATTERNS array: any one
// of these appearing in the serial log means the environment reached a
// real userspace, not just the bootloader/kernel.
var bootCheckSuccessPatterns = []string{
	"tbox-root.service: Deactivated successfully",
	"tbox-root.service: Succeeded",
	"Finished tbox-root.service",
	"ostree-prepare-root.service: Deactivated successfully",
	"Finished ostree-prepare-root.service",
	"Welcome to",
	"login:",
}

func firstExistingPath(paths []string) string {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// findOVMF locates the UEFI firmware QEMU needs to boot a bootc/systemd-boot
// image. Returns a *PrerequisiteError (with an apt/dnf-based auto-fix) if
// missing, matching the pattern used elsewhere in this app (checkWSL2,
// installQEMU) so a non-technical user gets a one-click fix instead of a
// dead-end error about missing firmware files.
func findOVMF() (codePath, varsPath string, err error) {
	codePath = firstExistingPath(ovmfCodePaths)
	varsPath = firstExistingPath(ovmfVarsPaths)
	if codePath == "" || varsPath == "" {
		return "", "", &PrerequisiteError{
			Message:  "Verifying by booting needs QEMU and OVMF (UEFI firmware for virtual machines), and they aren't installed yet.",
			FixLabel: "Install QEMU + OVMF",
			Fix:      installQEMUAndOVMFLinux,
		}
	}
	return codePath, varsPath, nil
}

// installQEMUAndOVMFLinux tries apt first (Debian/Ubuntu-family), then dnf
// (Fedora/bootc-family) — covers the two package ecosystems this app's
// other Linux-side prerequisite handling already assumes exist somewhere
// on a user's system (see native/README.md).
func installQEMUAndOVMFLinux(onLine func(string)) error {
	if _, err := exec.LookPath("apt-get"); err == nil {
		onLine("Installing qemu-system-x86 and OVMF via apt...")
		return runLinuxInstallCmd(onLine, "sudo", "apt-get", "install", "-y", "qemu-system-x86", "ovmf")
	}
	if _, err := exec.LookPath("dnf"); err == nil {
		onLine("Installing qemu-kvm and edk2-ovmf via dnf...")
		return runLinuxInstallCmd(onLine, "sudo", "dnf", "install", "-y", "qemu-kvm", "edk2-ovmf")
	}
	return fmt.Errorf("neither apt-get nor dnf found — install qemu-system-x86_64 and OVMF firmware manually for your distribution")
}

// runLinuxInstallCmd runs a package-manager install command, streaming
// output line by line so the UI's log view shows real progress.
func runLinuxInstallCmd(onLine func(string), name string, args ...string) error {
	cmd := exec.Command(name, args...)
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

// bootCheckSupported reports whether this platform can run the optional
// post-write boot verification (main.go's "Verify by booting" checkbox).
func bootCheckSupported() bool { return true }

// runBootCheck is the platform-neutral entry point main.go calls — see
// bootcheck_darwin.go/bootcheck_windows.go for why this feature is
// Linux-only for now.
func runBootCheck(drivePath string, onLine func(string)) error {
	return bootCheckLinux(drivePath, 3*time.Minute, onLine)
}

// bootCheckLinux boots drivePath in QEMU/OVMF and confirms it reaches a
// real userspace within timeout, mirroring test-boot.sh's logic. Returns
// nil only on a confirmed successful boot; any failure (timeout, kernel
// panic, QEMU error) returns a descriptive error with the tail of the
// serial log attached so the UI can show the real reason.
func bootCheckLinux(drivePath string, timeout time.Duration, onLine func(string)) error {
	ovmfCode, ovmfVarsSrc, err := findOVMF()
	if err != nil {
		return err
	}

	varsCopy, err := os.CreateTemp("", "tacklebox-app-ovmf-vars-*.fd")
	if err != nil {
		return err
	}
	varsCopyPath := varsCopy.Name()
	defer os.Remove(varsCopyPath)
	src, err := os.Open(ovmfVarsSrc)
	if err != nil {
		varsCopy.Close()
		return err
	}
	_, copyErr := io.Copy(varsCopy, src)
	src.Close()
	varsCopy.Close()
	if copyErr != nil {
		return copyErr
	}

	accel, cpu := "tcg", "max"
	if _, err := os.Stat("/dev/kvm"); err == nil {
		accel, cpu = "kvm", "host"
	}

	onLine(fmt.Sprintf("Booting %s in QEMU (accel=%s, timeout=%s)...", drivePath, accel, timeout))

	cmd := exec.Command("qemu-system-x86_64",
		"-m", "2G",
		"-smp", "2",
		"-accel", accel,
		"-cpu", cpu,
		"-drive", "if=pflash,format=raw,readonly=on,file="+ovmfCode,
		"-drive", "if=pflash,format=raw,file="+varsCopyPath,
		"-drive", "file="+drivePath+",format=raw,if=virtio",
		"-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0",
		"-serial", "stdio",
		"-display", "none",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}

	result := make(chan error, 1)
	go func() {
		result <- watchBootLog(stdout, timeout, onLine)
	}()

	err = <-result
	_ = cmd.Process.Kill()
	cmd.Wait()
	return err
}

var kernelPanicRe = regexp.MustCompile(`(?i)kernel panic`)

// watchBootLog scans QEMU's serial output for a success or failure signal,
// returning as soon as one is found rather than waiting out the full
// timeout in the success case (same fail-fast principle as vm_darwin.go's
// waitForSSH, which this session's own testing found matters in
// practice — a hung/crashed boot burning the user's full timeout budget
// is a real, previously-hit class of bug elsewhere in this app).
func watchBootLog(r io.Reader, timeout time.Duration, onLine func(string)) error {
	deadline := time.Now().Add(timeout)
	scanner := bufio.NewScanner(r)
	var tail []string
	const tailLimit = 20

	lines := make(chan string)
	go func() {
		defer close(lines)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()

	for {
		select {
		case line, ok := <-lines:
			if !ok {
				return fmt.Errorf("QEMU exited before reaching a recognizable boot state\nlast output:\n%s", strings.Join(tail, "\n"))
			}
			onLine(line)
			tail = append(tail, line)
			if len(tail) > tailLimit {
				tail = tail[1:]
			}
			if kernelPanicRe.MatchString(line) {
				return fmt.Errorf("kernel panic during boot check\nlast output:\n%s", strings.Join(tail, "\n"))
			}
			for _, pattern := range bootCheckSuccessPatterns {
				if strings.Contains(line, pattern) {
					return nil
				}
			}
		case <-time.After(time.Until(deadline)):
			return fmt.Errorf("timed out after %s waiting for a successful boot\nlast output:\n%s", timeout, strings.Join(tail, "\n"))
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for a successful boot\nlast output:\n%s", timeout, strings.Join(tail, "\n"))
		}
	}
}
