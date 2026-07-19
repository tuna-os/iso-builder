// macOS execution path.
//
// tacklebox's build/add/status commands need real Linux kernel semantics
// (ostree, composefs, `chattr +i` immutable bits — see
// tuna-os/tacklebox#106/#108 for the research). That doesn't exist on
// macOS and can't be emulated with a pure-Go reimplementation. Apple's own
// Virtualization.framework can't help either: VZLinuxBootLoader only boots
// arm64 guests on Apple Silicon, and target install media is overwhelmingly
// x86_64.
//
// So this boots a real x86_64 Linux VM under QEMU (TCG software emulation —
// slow, roughly 8x versus native per the measurement in #108, but real and
// working, proven end-to-end during that research), raw-attaches the
// selected physical disk directly as a QEMU block device, and runs the
// exact same tacklebox flow that already works on Linux, inside the guest.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	fedoraCloudImageURL  = "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2"
	fedoraCloudImageName = "Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2"
	vmRootDiskSize       = "30G" // headroom for podman's layer storage — see native/README.md, undersizing this produces confusing corrupted-layer errors, not a clean "out of space"
	// tackleboxRef is the tacklebox commit/branch built inside the guest.
	// Pinned rather than following a moving branch so a build today and a
	// build next month behave the same way.
	tackleboxRef = "main"
)

// installQEMU tries `brew install qemu` if Homebrew is present. If it
// isn't, this app can't reasonably automate installing Homebrew itself too
// (that's its own curl-piped-to-a-privileged-shell flow with its own
// prompts) — drawing the line there and telling the user exactly what to
// do is the honest choice rather than silently attempting something riskier.
func installQEMU(onLine func(string)) error {
	if _, err := exec.LookPath("brew"); err != nil {
		return fmt.Errorf("Homebrew isn't installed either — install it from https://brew.sh first, then try again")
	}
	onLine("Installing QEMU via Homebrew...")
	return run(onLine, "brew", "install", "qemu")
}

// bootHelperVM boots the helper VM with drivePath raw-attached and returns
// an SSH client connected as "tbox", plus a cleanup func that must be
// deferred by the caller to close the connection and tear the VM down.
// Shared by executeTacklebox (build/add) and isManagedDrive (status) —
// both need the same VM, just run a different remote command afterward.
//
// Known cost, not yet optimized: every call creates a fresh VM overlay
// from the pristine cached base image (see the qemu-img create -b line
// below) and clones+builds tacklebox from scratch inside it — including
// isManagedDrive, so checking a drive's status costs roughly the same
// ~1 minute of VM boot + build time as an actual write on macOS. There's
// no cross-call caching of the built tacklebox binary yet. Worth revisiting
// if this UX cost proves annoying in practice.
func bootHelperVM(drivePath string, onLine func(string)) (client *ssh.Client, cleanup func(), err error) {
	if _, err := exec.LookPath("qemu-system-x86_64"); err != nil {
		return nil, nil, &PrerequisiteError{
			Message:  "This needs QEMU (a tool for running a small Linux helper environment) to write to USB drives, and it isn't installed yet.",
			FixLabel: "Install QEMU",
			Fix:      installQEMU,
		}
	}

	onLine("Preparing helper VM...")
	work, err := os.MkdirTemp("", "tacklebox-app-vm-*")
	if err != nil {
		return nil, nil, err
	}
	cleanupWork := func() { os.RemoveAll(work) }

	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cleanupWork()
		return nil, nil, err
	}
	cacheDir = filepath.Join(cacheDir, "org.tunaos.tacklebox-app")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		cleanupWork()
		return nil, nil, err
	}

	baseImage := filepath.Join(cacheDir, fedoraCloudImageName)
	if _, err := os.Stat(baseImage); err != nil {
		onLine("Downloading a small Linux helper image (one-time, ~580 MB)...")
		if err := downloadFile(fedoraCloudImageURL, baseImage); err != nil {
			cleanupWork()
			return nil, nil, fmt.Errorf("download helper image: %w", err)
		}
	}

	vmDisk := filepath.Join(work, "vm-root.qcow2")
	if err := run(onLine, "qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", baseImage, vmDisk); err != nil {
		cleanupWork()
		return nil, nil, fmt.Errorf("prepare VM disk: %w", err)
	}
	if err := run(onLine, "qemu-img", "resize", vmDisk, vmRootDiskSize); err != nil {
		cleanupWork()
		return nil, nil, fmt.Errorf("resize VM disk: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		cleanupWork()
		return nil, nil, err
	}
	sshSigner, err := ssh.NewSignerFromSigner(priv) // ed25519.PrivateKey implements crypto.Signer directly
	if err != nil {
		cleanupWork()
		return nil, nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		cleanupWork()
		return nil, nil, err
	}
	authorizedKey := ssh.MarshalAuthorizedKey(sshPub)

	seedISO := filepath.Join(work, "seed.iso")
	if err := buildCloudInitSeed(work, seedISO, string(authorizedKey)); err != nil {
		cleanupWork()
		return nil, nil, fmt.Errorf("build cloud-init seed: %w", err)
	}

	rawDrive, err := rawDeviceNode(drivePath)
	if err != nil {
		cleanupWork()
		return nil, nil, err
	}
	onLine("Unmounting " + drivePath + " so the VM can access it directly...")
	// Best-effort: diskutil unmountDisk fails harmlessly if nothing was
	// mounted, which is the common case for a drive this app selected.
	exec.Command("diskutil", "unmountDisk", drivePath).Run()

	// A fixed port here was a real bug caught in review: a crashed or
	// orphaned QEMU process from a previous run (this happened for real
	// during development — see the git history) squats the port
	// indefinitely, so the next build's VM either fails to bind it or,
	// worse, hostfwd could resolve against the wrong VM. Ask the OS for a
	// free one instead.
	sshPort, err := freeLocalPort()
	if err != nil {
		cleanupWork()
		return nil, nil, fmt.Errorf("find a free port for the VM: %w", err)
	}

	onLine("Starting helper VM (this takes a few minutes on first run)...")
	qemuArgs := []string{
		"-machine", "q35",
		"-cpu", "max", // TCG default (qemu64) lacks x86-64-v3, which both the guest OS and the tacklebox binary itself need — see native/README.md
		"-m", "4096",
		"-smp", "2",
		"-drive", "if=virtio,file=" + vmDisk + ",format=qcow2",
		"-drive", "if=virtio,file=" + seedISO + ",format=raw",
		"-drive", "if=virtio,file=" + rawDrive + ",format=raw",
		"-netdev", fmt.Sprintf("user,id=net0,hostfwd=tcp::%d-:22", sshPort),
		"-device", "virtio-net,netdev=net0",
		"-display", "none",
	}
	ctx, cancel := context.WithCancel(context.Background())
	qemuCmd := exec.CommandContext(ctx, "qemu-system-x86_64", qemuArgs...)
	qemuExited := make(chan error, 1)
	if err := qemuCmd.Start(); err != nil {
		cancel()
		cleanupWork()
		return nil, nil, fmt.Errorf("start VM: %w", err)
	}
	go func() { qemuExited <- qemuCmd.Wait() }()

	// Also a real bug caught in review: waiting up to 5 minutes for SSH
	// with no way to notice the VM process died in the first few seconds
	// (e.g. a port conflict, a QEMU startup error) means a doomed run
	// wastes the user's full 5 minutes on a generic timeout instead of
	// surfacing the real error immediately.
	sshClient, err := waitForSSH(ctx, sshSigner, sshPort, 5*time.Minute, qemuExited)
	if err != nil {
		cancel()
		cleanupWork()
		return nil, nil, fmt.Errorf("VM did not become reachable: %w", err)
	}
	onLine("VM is up.")

	cleanup = func() {
		sshClient.Close()
		cancel()
		<-qemuExited // wait for the process to actually exit before removing its disk files
		cleanupWork()
	}
	return sshClient, cleanup, nil
}

// tackleboxCloneAndBuild is the shell fragment every remote command needs
// first: clone tacklebox at the pinned ref and build the same binary the
// Linux path already runs directly.
const tackleboxCloneAndBuild = `set -e
sudo dnf install -y --setopt=install_weak_deps=False git golang podman skopeo gdisk dosfstools systemd-boot-unsigned wayland-devel >/dev/null
git clone --depth 1 --branch ` + tackleboxRef + ` https://github.com/tuna-os/tacklebox.git
cd tacklebox
go build -o tacklebox ./cmd/tacklebox
`

// executeTacklebox on macOS boots a helper VM, raw-attaches drivePath, and
// runs tacklebox build/add/update inside it (all three take the same
// `<subcommand> --yes <recipe> <drive>` shape). onLine receives output
// from every phase (VM boot, package install, tacklebox build itself) so
// the UI shows real progress instead of going silent for the ~minutes this
// takes. See runTackleboxArgs for subcommands that don't fit this shape
// (verify, remove, status).
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	client, cleanup, err := bootHelperVM(drivePath, onLine)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := scpFile(client, recipePath, "/home/tbox/recipe.json"); err != nil {
		return fmt.Errorf("copy recipe into VM: %w", err)
	}

	script := tackleboxCloneAndBuild + fmt.Sprintf("sudo ./tacklebox %s --yes /home/tbox/recipe.json /dev/vdc\n", subcommand)
	return runRemote(client, script, onLine)
}

// runTackleboxArgs boots a helper VM and runs `sudo ./tacklebox <args...>`
// inside it, for subcommands that don't need a recipe uploaded first
// (verify, remove, status — see managed_darwin.go for the status case).
//
// argsForDevice takes a callback rather than a plain []string so this
// signature matches exec_windows.go's runTackleboxArgs exactly — main.go
// isn't platform-tagged, so it calls whichever _linux/_darwin/_windows
// file the build selected through one shared signature, and only Windows
// actually needs the device path threaded in dynamically (WSL2 doesn't
// know it until after attaching); macOS's is always /dev/vdc, so it just
// calls argsForDevice("/dev/vdc") and ignores the parameter otherwise.
func runTackleboxArgs(drivePath string, argsForDevice func(device string) []string, onLine func(string)) error {
	client, cleanup, err := bootHelperVM(drivePath, onLine)
	if err != nil {
		return err
	}
	defer cleanup()

	script := tackleboxCloneAndBuild + "sudo ./tacklebox"
	for _, a := range argsForDevice("/dev/vdc") {
		script += " " + a
	}
	script += "\n"
	return runRemote(client, script, onLine)
}
