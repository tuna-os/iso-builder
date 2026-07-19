// Windows execution path.
//
// Same underlying constraint as macOS (exec_darwin.go): tacklebox's
// build/add commands need a real Linux kernel (bootc install → ostree →
// composefs, see tuna-os/tacklebox#106/#108). Windows has a much better
// answer than macOS here: WSL2 is a real, Microsoft-maintained Linux
// kernel already built into Windows 10 2004+/11 — no bundled VM image, no
// software CPU emulation, no ~8x slowdown.
//
// The one complication: `wsl --mount` explicitly does not support USB
// drives (confirmed during tuna-os/tacklebox#107's research — it only
// takes whole fixed/internal disks). The supported path for USB
// specifically is usbipd-win (https://github.com/dorssel/usbipd-win,
// Microsoft-affiliated, USB/IP protocol), which attaches the device into
// WSL2 where it enumerates as a real block device once the in-WSL2 kernel
// binds a driver to it.
//
// VERIFICATION STATUS: unlike the Linux and macOS paths, none of this has
// been run against a real Windows machine — no Windows dev environment
// was reachable this session (a full Windows-in-KVM environment exists
// via dockur/windows for manual testing, but running WSL2 inside that
// itself needs nested virtualization, which may not even be available
// there). The usbipd<->Win32_DiskDrive correlation in findUsbipdBusID
// below is the part most likely to need real-hardware iteration — it's a
// reasonable best-effort match on VID:PID, not something confirmed
// against real `usbipd list` output.
package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// executeTacklebox on Windows attaches drivePath into WSL2 via usbipd-win
// and runs tacklebox inside the default WSL distro.
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	if err := checkWSL2(); err != nil {
		return err
	}
	if _, err := exec.LookPath("usbipd"); err != nil {
		return fmt.Errorf("usbipd-win not found — install it first (https://github.com/dorssel/usbipd-win/releases, or `winget install usbipd`)")
	}

	onLine("Locating " + drivePath + " on the USB bus...")
	busID, err := findUsbipdBusID(drivePath)
	if err != nil {
		return fmt.Errorf("could not identify the USB bus ID for %s: %w", drivePath, err)
	}

	onLine("Attaching " + drivePath + " (bus " + busID + ") into WSL2...")
	if err := runWindows(onLine, "usbipd", "attach", "--wsl", "--busid", busID); err != nil {
		return fmt.Errorf("usbipd attach: %w", err)
	}
	// The device needs a moment to enumerate inside the WSL2 kernel after
	// attach — usbipd's own attach command returns once the USB layer is
	// up, not once a SCSI/block driver has bound to it.
	time.Sleep(5 * time.Second)

	guestDevice, err := findNewBlockDeviceInWSL()
	if err != nil {
		return fmt.Errorf("drive attached but not found inside WSL2: %w", err)
	}
	onLine("Drive is visible inside WSL2 as " + guestDevice)

	winRecipePath, err := wslCopyIn(recipePath)
	if err != nil {
		return fmt.Errorf("copy recipe into WSL2: %w", err)
	}

	setupScript := fmt.Sprintf(`set -e
sudo apt-get update -qq
sudo apt-get install -y -qq git golang-go podman skopeo gdisk dosfstools systemd-boot >/dev/null
git clone --depth 1 --branch main https://github.com/tuna-os/tacklebox.git
cd tacklebox
go build -o tacklebox ./cmd/tacklebox
sudo ./tacklebox %s --yes %s %s
`, subcommand, winRecipePath, guestDevice)

	return runWSLScript(setupScript, onLine)
}

// checkWSL2 confirms a WSL2 distro is available. Does not attempt to
// install one — `wsl --install` is a slow, reboot-prone operation that
// shouldn't happen silently inside a build click.
func checkWSL2() error {
	out, err := exec.Command("wsl", "--status").CombinedOutput()
	if err != nil {
		return fmt.Errorf("WSL not available — run `wsl --install` first, then restart: %w", err)
	}
	if !strings.Contains(string(out), "2") {
		return fmt.Errorf("WSL is installed but not on version 2 — run `wsl --set-default-version 2`")
	}
	return nil
}

// findUsbipdBusID correlates a Win32_DiskDrive DeviceID with a USB bus ID
// reported by `usbipd list`, via the VID:PID embedded in the disk's
// PNPDeviceID. See the package doc comment: this is best-effort, not
// verified against real hardware.
func findUsbipdBusID(drivePath string) (string, error) {
	script := fmt.Sprintf(`Get-CimInstance Win32_DiskDrive | Where-Object { $_.DeviceID -eq %q } | Select-Object -ExpandProperty PNPDeviceID`, drivePath)
	out, err := exec.Command("powershell", "-NoProfile", "-Command", script).Output()
	if err != nil {
		return "", fmt.Errorf("look up PNPDeviceID: %w", err)
	}
	pnpID := strings.TrimSpace(string(out))

	vidPid := extractVidPid(pnpID)
	if vidPid == "" {
		return "", fmt.Errorf("could not extract VID:PID from PNPDeviceID %q", pnpID)
	}

	listOut, err := exec.Command("usbipd", "list").Output()
	if err != nil {
		return "", fmt.Errorf("usbipd list: %w", err)
	}
	busID, err := parseUsbipdBusID(string(listOut), vidPid)
	if err != nil {
		return "", err
	}
	return busID, nil
}

var pnpVidPidRe = regexp.MustCompile(`VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})`)

// extractVidPid pulls "vvvv:pppp" (lowercase, usbipd's format) out of a
// Windows PNPDeviceID string like
// "USB\VID_0951&PID_1666\...".
func extractVidPid(pnpID string) string {
	m := pnpVidPidRe.FindStringSubmatch(pnpID)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1] + ":" + m[2])
}

// parseUsbipdBusID scans `usbipd list` text output for a line containing
// vidPid and returns its leading bus ID column (e.g. "2-3"). usbipd's
// output format is column-aligned text, not JSON, as of the versions
// documented when this was written — worth double-checking against a real
// `usbipd list --usbids` run if this starts failing to match.
func parseUsbipdBusID(listing, vidPid string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(listing))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(strings.ToLower(line), vidPid) {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				return fields[0], nil
			}
		}
	}
	return "", fmt.Errorf("no usbipd device matching %s found in `usbipd list` output", vidPid)
}

// findNewBlockDeviceInWSL asks the WSL2 guest for its block devices and
// returns the path of a whole disk with no partition table yet — the
// just-attached drive, on the (reasonable but unverified) assumption
// nothing else in the guest matches that description at the moment this
// runs.
func findNewBlockDeviceInWSL() (string, error) {
	out, err := exec.Command("wsl", "-e", "bash", "-c", "lsblk -ndo NAME,TYPE").Output()
	if err != nil {
		return "", err
	}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	var last string
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[1] == "disk" {
			last = "/dev/" + fields[0]
		}
	}
	if last == "" {
		return "", fmt.Errorf("no disk devices visible in WSL2 (lsblk output: %q)", strings.TrimSpace(string(out)))
	}
	return last, nil
}

// wslCopyIn copies a Windows host file into the default WSL2 distro's
// filesystem via the \\wsl$ share, and returns the resulting Linux path.
func wslCopyIn(winPath string) (string, error) {
	cmd := exec.Command("wsl", "-e", "bash", "-c", "echo $HOME")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	home := strings.TrimSpace(string(out))
	target := home + "/recipe.json"

	copyCmd := exec.Command("wsl", "-e", "bash", "-c",
		fmt.Sprintf("cp %q %q", toWSLPath(winPath), target))
	if out, err := copyCmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%w: %s", err, out)
	}
	return target, nil
}

// toWSLPath converts a Windows path like C:\Users\x\y.json to the WSL
// mount equivalent /mnt/c/Users/x/y.json.
func toWSLPath(winPath string) string {
	if len(winPath) < 2 || winPath[1] != ':' {
		return winPath
	}
	drive := strings.ToLower(winPath[:1])
	rest := strings.ReplaceAll(winPath[2:], `\`, "/")
	return "/mnt/" + drive + rest
}

// runWindows runs a host-side command, streaming output to onLine.
func runWindows(onLine func(string), name string, args ...string) error {
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

// runWSLScript runs script inside the default WSL2 distro via `wsl -e bash
// -s`, streaming output to onLine.
func runWSLScript(script string, onLine func(string)) error {
	cmd := exec.Command("wsl", "-e", "bash", "-s")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		return err
	}
	if _, err := stdin.Write([]byte(script)); err != nil {
		return err
	}
	stdin.Close()

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		onLine(scanner.Text())
	}
	return cmd.Wait()
}
