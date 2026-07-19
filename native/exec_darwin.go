// macOS execution path.
//
// tacklebox's build/add commands run `bootc install`, which needs real
// Linux kernel semantics (ostree, composefs, `chattr +i` immutable bits —
// see tuna-os/tacklebox#106/#108 for the research). That doesn't exist on
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
	vmSSHPort            = 2222
	vmRootDiskSize       = "30G" // headroom for podman's layer storage — see native/README.md, undersizing this produces confusing corrupted-layer errors, not a clean "out of space"
	// tackleboxRef is the tacklebox commit/branch built inside the guest.
	// Pinned rather than following a moving branch so a build today and a
	// build next month behave the same way.
	tackleboxRef = "main"
)

// executeTacklebox on macOS boots a helper VM, raw-attaches drivePath, and
// runs tacklebox inside it. onLine receives output from every phase
// (VM boot, package install, tacklebox build itself) so the UI shows real
// progress instead of going silent for the ~minutes this takes.
func executeTacklebox(subcommand, recipePath, drivePath string, onLine func(string)) error {
	if _, err := exec.LookPath("qemu-system-x86_64"); err != nil {
		return fmt.Errorf("qemu-system-x86_64 not found — install it first (e.g. `brew install qemu`)")
	}

	onLine("Preparing helper VM...")
	work, err := os.MkdirTemp("", "tacklebox-app-vm-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	cacheDir = filepath.Join(cacheDir, "org.tunaos.tacklebox-app")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return err
	}

	baseImage := filepath.Join(cacheDir, fedoraCloudImageName)
	if _, err := os.Stat(baseImage); err != nil {
		onLine("Downloading a small Linux helper image (one-time, ~580 MB)...")
		if err := downloadFile(fedoraCloudImageURL, baseImage); err != nil {
			return fmt.Errorf("download helper image: %w", err)
		}
	}

	vmDisk := filepath.Join(work, "vm-root.qcow2")
	if err := run(onLine, "qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", baseImage, vmDisk); err != nil {
		return fmt.Errorf("prepare VM disk: %w", err)
	}
	if err := run(onLine, "qemu-img", "resize", vmDisk, vmRootDiskSize); err != nil {
		return fmt.Errorf("resize VM disk: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	sshSigner, err := ssh.NewSignerFromSigner(priv) // ed25519.PrivateKey implements crypto.Signer directly
	if err != nil {
		return err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return err
	}
	authorizedKey := ssh.MarshalAuthorizedKey(sshPub)

	seedISO := filepath.Join(work, "seed.iso")
	if err := buildCloudInitSeed(work, seedISO, string(authorizedKey)); err != nil {
		return fmt.Errorf("build cloud-init seed: %w", err)
	}

	rawDrive, err := rawDeviceNode(drivePath)
	if err != nil {
		return err
	}
	onLine("Unmounting " + drivePath + " so the VM can access it directly...")
	// Best-effort: diskutil unmountDisk fails harmlessly if nothing was
	// mounted, which is the common case for a drive this app selected.
	exec.Command("diskutil", "unmountDisk", drivePath).Run()

	onLine("Starting helper VM (this takes a few minutes on first run)...")
	qemuArgs := []string{
		"-machine", "q35",
		"-cpu", "max", // TCG default (qemu64) lacks x86-64-v3, which both the guest OS and the tacklebox binary itself need — see native/README.md
		"-m", "4096",
		"-smp", "2",
		"-drive", "if=virtio,file=" + vmDisk + ",format=qcow2",
		"-drive", "if=virtio,file=" + seedISO + ",format=raw",
		"-drive", "if=virtio,file=" + rawDrive + ",format=raw",
		"-netdev", fmt.Sprintf("user,id=net0,hostfwd=tcp::%d-:22", vmSSHPort),
		"-device", "virtio-net,netdev=net0",
		"-display", "none",
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	qemuCmd := exec.CommandContext(ctx, "qemu-system-x86_64", qemuArgs...)
	if err := qemuCmd.Start(); err != nil {
		return fmt.Errorf("start VM: %w", err)
	}
	defer func() {
		cancel()
		qemuCmd.Wait()
	}()

	client, err := waitForSSH(ctx, sshSigner, 5*time.Minute)
	if err != nil {
		return fmt.Errorf("VM did not become reachable: %w", err)
	}
	defer client.Close()
	onLine("VM is up.")

	if err := scpFile(client, recipePath, "/home/tbox/recipe.json"); err != nil {
		return fmt.Errorf("copy recipe into VM: %w", err)
	}

	setupScript := fmt.Sprintf(`set -e
sudo dnf install -y --setopt=install_weak_deps=False git golang podman skopeo gdisk dosfstools systemd-boot-unsigned wayland-devel >/dev/null
git clone --depth 1 --branch %s https://github.com/tuna-os/tacklebox.git
cd tacklebox
go build -o tacklebox ./cmd/tacklebox
sudo ./tacklebox %s --yes /home/tbox/recipe.json /dev/vdc
`, tackleboxRef, subcommand)

	return runRemote(client, setupScript, onLine)
}
