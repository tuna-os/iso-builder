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
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// attachDriveToWSL checks prerequisites, attaches drivePath into WSL2 via
// usbipd-win, and returns the resulting guest block device path (e.g.
// /dev/sdb). Shared by executeTacklebox, runTackleboxArgs, and
// managed_windows.go's isManagedDrive — all three need the drive attached
// before they can do anything else.
func attachDriveToWSL(drivePath string, onLine func(string)) (string, error) {
	if err := checkWSL2(); err != nil {
		return "", err
	}
	if _, err := exec.LookPath("usbipd"); err != nil {
		return "", &PrerequisiteError{
			Message:  "This needs usbipd-win (lets WSL2 see USB drives) to write to USB drives, and it isn't installed yet.",
			FixLabel: "Install usbipd-win",
			Fix:      installUsbipd,
		}
	}

	onLine("Locating " + drivePath + " on the USB bus...")
	busID, err := findUsbipdBusID(drivePath)
	if err != nil {
		return "", fmt.Errorf("could not identify the USB bus ID for %s: %w", drivePath, err)
	}

	onLine("Attaching " + drivePath + " (bus " + busID + ") into WSL2...")
	if err := runWindows(onLine, "usbipd", "attach", "--wsl", "--busid", busID); err != nil {
		return "", fmt.Errorf("usbipd attach: %w", err)
	}
	// The device needs a moment to enumerate inside the WSL2 kernel after
	// attach — usbipd's own attach command returns once the USB layer is
	// up, not once a SCSI/block driver has bound to it.
	time.Sleep(5 * time.Second)

	guestDevice, err := findNewBlockDeviceInWSL()
	if err != nil {
		return "", fmt.Errorf("drive attached but not found inside WSL2: %w", err)
	}
	onLine("Drive is visible inside WSL2 as " + guestDevice)
	return guestDevice, nil
}

// executeTacklebox on Windows attaches drivePath into WSL2 via usbipd-win
// and runs tacklebox build/add/update inside the default WSL distro (all
// three share the `<subcommand> --yes <recipe> <drive>` shape). See
// runTackleboxArgs for subcommands that don't fit it (verify, remove,
// status).
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	guestDevice, err := attachDriveToWSL(drivePath, onLine)
	if err != nil {
		return err
	}

	winRecipePath, err := wslCopyIn(recipePath)
	if err != nil {
		return fmt.Errorf("copy recipe into WSL2: %w", err)
	}

	script := wslTackleboxCloneAndBuild + fmt.Sprintf("sudo ./tacklebox %s --yes %s %s\n", subcommand, winRecipePath, guestDevice)
	return runWSLScript(script, onLine)
}

// runTackleboxArgs attaches drivePath into WSL2 and runs
// `sudo ./tacklebox <args...>` there, for subcommands that don't need a
// recipe uploaded first (verify, remove, status — see
// managed_windows.go). args should reference the guest device path
// returned by attachDriveToWSL, not the Windows drivePath.
func runTackleboxArgs(drivePath string, argsFn func(guestDevice string) []string, onLine func(string)) error {
	guestDevice, err := attachDriveToWSL(drivePath, onLine)
	if err != nil {
		return err
	}
	args := argsFn(guestDevice)

	script := wslTackleboxCloneAndBuild + "sudo ./tacklebox"
	for _, a := range args {
		script += " " + a
	}
	script += "\n"
	return runWSLScript(script, onLine)
}

// wslTackleboxCloneAndBuild is the shell fragment every WSL2 remote command
// needs first — clone tacklebox at the pinned ref and build the same
// binary the Linux path already runs directly. Shared by executeTacklebox
// (build/add) and isManagedDrive (status, managed_windows.go).
const wslTackleboxCloneAndBuild = `set -e
sudo apt-get update -qq
sudo apt-get install -y -qq git golang-go podman skopeo gdisk dosfstools systemd-boot >/dev/null
git clone --depth 1 --branch abd698c1f643ae7890a9f4d8ce3cd6ea49fb7f71 https://github.com/tuna-os/tacklebox.git
cd tacklebox
go build -o tacklebox ./cmd/tacklebox
`

// checkWSL2 confirms a WSL2 distro is available. If not, it returns a
// *PrerequisiteError carrying an automatic fix — this app's whole audience
// is people who don't know what a command line is (see
// tuna-os/iso-builder#1), so "go run wsl --install yourself" is not an
// acceptable dead end. installWSL2 still can't avoid the one thing only
// the user can do: acknowledge and sit through the required reboot.
func checkWSL2() error {
	out, err := exec.Command("wsl", "--status").CombinedOutput()
	if err != nil {
		return &PrerequisiteError{
			Message:  "This needs WSL2 (a Windows feature for running Linux tools) to write to USB drives, and it isn't installed yet.",
			FixLabel: "Install WSL2",
			Fix:      installWSL2,
		}
	}
	if !strings.Contains(string(out), "2") {
		return &PrerequisiteError{
			Message:  "WSL is installed but not set to version 2, which this app needs.",
			FixLabel: "Switch to WSL2",
			Fix: func(onLine func(string)) error {
				return runWindows(onLine, "wsl", "--set-default-version", "2")
			},
		}
	}
	return nil
}

// installUsbipd installs usbipd-win via winget, which ships built into
// Windows 10 2004+/11 (App Installer) — a safer default to shell out to
// directly than Homebrew's curl-piped-to-a-shell install on macOS, so
// unlike installQEMU this doesn't need a "the package manager itself is
// missing" fallback path for the common case.
func installUsbipd(onLine func(string)) error {
	onLine("Installing usbipd-win via winget...")
	if err := runWindows(onLine, "winget", "install", "--id", "dorssel.usbipd-win", "-e", "--accept-source-agreements", "--accept-package-agreements"); err != nil {
		return fmt.Errorf("winget install failed (if winget itself is missing, get it from the Microsoft Store as \"App Installer\", or download usbipd-win directly from https://github.com/dorssel/usbipd-win/releases): %w", err)
	}
	return nil
}

// installWSL2 enables the underlying Windows features WSL2 needs and
// installs the separate WSL2 Linux kernel update package.
//
// Originally this just ran `wsl --install --no-distribution`, the
// documented simple path. Live-tested against a real Windows 11 VM (see
// tuna-os/tacklebox#107): it did not work — the WSL optional feature
// stayed Disabled afterward, with no error surfaced to explain why. The
// lower-level DISM equivalent (Enable-WindowsOptionalFeature, run
// directly here) was tested against the same VM and did work
// (Online: True, RestartNeeded: True). Not every Windows edition/build
// supports the simplified `wsl --install` flow the same way, so this
// goes straight to the primitive that's actually confirmed reliable
// rather than trying the documented-but-unverified path first.
//
// Enabling the two optional features is not sufficient by itself: also
// live-tested against the same VM, `wsl --status` kept failing with "WSL
// is not installed" even after both features showed Enabled and a
// reboot. The missing piece is the WSL2 Linux kernel itself, which on a
// from-scratch machine ships as a separate MSI, not as part of either
// Windows feature — installKernelUpdate below fetches and runs it.
//
// Start-Process -Verb RunAs triggers the native Windows UAC elevation
// prompt rather than a custom dialog this app would have to build (and
// rather than silently failing if the app itself isn't already elevated).
func installWSL2(onLine func(string)) error {
	onLine("Requesting administrator permission to install WSL2...")
	script := `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -NoRestart; ` +
		`Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart`
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		fmt.Sprintf("Start-Process powershell -ArgumentList '-NoProfile','-Command','%s' -Verb RunAs -Wait", script))
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		onLine(string(out))
	}
	if err != nil {
		return fmt.Errorf("WSL2 install failed to start (did you decline the permission prompt?): %w", err)
	}

	if err := installKernelUpdate(onLine); err != nil {
		return fmt.Errorf("Windows features enabled, but installing the WSL2 kernel update failed: %w", err)
	}

	return fmt.Errorf("WSL2 is installing — your computer needs to restart once before this will work. Restart, then try again")
}

// wslKernelReleasesURL is the GitHub API endpoint for the WSL2 kernel
// update package's latest release. Deliberately not a static
// .../releases/latest/download/wsl.x64.msi URL: that alias assumes a
// fixed asset filename, but the real filename is versioned (e.g.
// wsl.2.7.10.0.x64.msi as of this writing) and changes with every
// release — confirmed live when the static-alias URL silently redirected
// to GitHub's HTML release page instead of the MSI. Querying the API and
// picking the matching asset by pattern survives future version bumps.
const wslKernelReleasesURL = "https://api.github.com/repos/microsoft/WSL/releases/latest"

var wslKernelAssetRe = regexp.MustCompile(`^wsl\..*\.x64\.msi$`)

// installKernelUpdate downloads and silently installs the WSL2 Linux
// kernel update MSI. This is separate from (and in addition to) the
// Windows optional features enabled in installWSL2 — see that function's
// doc comment for why both are required.
func installKernelUpdate(onLine func(string)) error {
	onLine("Looking up the latest WSL2 kernel update...")
	assetURL, err := latestWSLKernelMSIURL()
	if err != nil {
		return fmt.Errorf("could not find the WSL2 kernel update download: %w", err)
	}

	msiPath := filepath.Join(os.TempDir(), "wsl-kernel-update.msi")
	onLine("Downloading WSL2 kernel update from " + assetURL + "...")
	if err := downloadFileHTTP(assetURL, msiPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer os.Remove(msiPath)

	// The kernel update installs machine-wide and needs admin, same as
	// the optional-feature enable above — msiexec run un-elevated fails
	// silently for a non-admin user. (This didn't surface during live
	// testing because the test harness drove the whole flow through QGA,
	// which runs as SYSTEM — already privileged enough to mask a missing
	// elevation request that a real, non-admin user account would hit.)
	onLine("Installing WSL2 kernel update (requesting administrator permission)...")
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		fmt.Sprintf("Start-Process msiexec.exe -ArgumentList '/i','%s','/qn','/norestart' -Verb RunAs -Wait", msiPath))
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		onLine(string(out))
	}
	return err
}

// wslReleaseAsset mirrors the fields this app needs from a GitHub release
// asset. Kept as a named type (rather than inline in latestWSLKernelMSIURL)
// so selectWSLKernelAsset's matching logic is testable independent of any
// real HTTP call.
type wslReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// latestWSLKernelMSIURL queries the GitHub API for the current WSL2
// kernel update release and returns the x64 MSI asset's download URL.
func latestWSLKernelMSIURL() (string, error) {
	resp, err := http.Get(wslKernelReleasesURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API returned %s", resp.Status)
	}

	var release struct {
		Assets []wslReleaseAsset `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", err
	}

	return selectWSLKernelAsset(release.Assets)
}

// selectWSLKernelAsset picks the x64 MSI out of a release's asset list.
// Split out from latestWSLKernelMSIURL so this matching logic — the part
// most likely to break silently as Microsoft's naming conventions shift —
// has a real unit test instead of only ever being exercised by a live
// GitHub API call.
func selectWSLKernelAsset(assets []wslReleaseAsset) (string, error) {
	for _, a := range assets {
		if wslKernelAssetRe.MatchString(strings.ToLower(a.Name)) {
			return a.BrowserDownloadURL, nil
		}
	}
	return "", fmt.Errorf("no x64 MSI asset found in latest release (got %d assets)", len(assets))
}

// downloadFileHTTP downloads url to destPath. Windows' bundled PowerShell
// on older images defaults to TLS 1.0/1.1 for Invoke-WebRequest, which
// GitHub's servers reject outright (confirmed live: "The request was
// aborted: The connection was closed unexpectedly") — shelling out to
// PowerShell to fetch this would inherit that problem. Downloading here
// in the Go binary itself sidesteps it: Go's net/http negotiates TLS 1.2+
// by default.
func downloadFileHTTP(url, destPath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %s", resp.Status)
	}

	out, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
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
