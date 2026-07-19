package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// downloadFile fetches url to dest, writing to a temp file first so a
// crash/interrupt mid-download can't leave a corrupt file at the final
// cache path (which would then look "already cached" on the next run).
func downloadFile(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %s", resp.Status)
	}

	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, dest)
}

// run executes name with args, streaming combined output to onLine, and
// returns an error including that output if the command fails (so a
// failure surfaces the real reason in the UI, not just "exit status 1").
func run(onLine func(string), name string, args ...string) error {
	cmd := exec.Command(name, args...)
	var out strings.Builder
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
		line := scanner.Text()
		out.WriteString(line + "\n")
		onLine(line)
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%w: %s", err, out.String())
	}
	return nil
}

// rawDeviceNode converts a buffered macOS device node (/dev/diskN) into its
// raw counterpart (/dev/rdiskN). Confirmed during tuna-os/tacklebox#108's
// research that raw is the one to use for throughput — the buffered node
// is what diskutil/enumeration reports, not what a real write should
// target.
func rawDeviceNode(path string) (string, error) {
	dir, name := filepath.Split(path)
	if !strings.HasPrefix(name, "disk") {
		return "", fmt.Errorf("unexpected device path %q", path)
	}
	return dir + "r" + name, nil
}

// buildCloudInitSeed writes a NoCloud cloud-init seed (meta-data + user-data
// authorizing authorizedKey for the "tbox" user) and packs it into an ISO9660
// volume at seedISOPath via hdiutil — native macOS tooling, no extra
// dependency needed (see native/README.md for how this was worked out).
func buildCloudInitSeed(workDir, seedISOPath, authorizedKey string) error {
	seedDir := filepath.Join(workDir, "seed")
	if err := os.MkdirAll(seedDir, 0o755); err != nil {
		return err
	}
	metaData := "instance-id: tacklebox-app-vm\nlocal-hostname: tacklebox-app-vm\n"
	if err := os.WriteFile(filepath.Join(seedDir, "meta-data"), []byte(metaData), 0o644); err != nil {
		return err
	}
	userData := fmt.Sprintf(`#cloud-config
users:
  - name: tbox
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - %s
`, strings.TrimSpace(authorizedKey))
	if err := os.WriteFile(filepath.Join(seedDir, "user-data"), []byte(userData), 0o644); err != nil {
		return err
	}

	cmd := exec.Command("hdiutil", "makehybrid", "-iso", "-joliet",
		"-default-volume-name", "cidata", "-o", seedISOPath, seedDir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("hdiutil makehybrid: %w: %s", err, out)
	}
	return nil
}

// waitForSSH polls localhost:vmSSHPort until an SSH handshake succeeds as
// the "tbox" user, or timeout elapses. The VM takes real time to boot —
// this is expected to loop for a while, not fail fast.
func waitForSSH(ctx context.Context, signer ssh.Signer, timeout time.Duration) (*ssh.Client, error) {
	deadline := time.Now().Add(timeout)
	config := &ssh.ClientConfig{
		User:            "tbox",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // ephemeral VM, ephemeral host key — nothing to pin
		Timeout:         5 * time.Second,
	}
	addr := fmt.Sprintf("127.0.0.1:%d", vmSSHPort)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		conn.Close()

		client, err := ssh.Dial("tcp", addr, config)
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		return client, nil
	}
	return nil, fmt.Errorf("timed out after %s", timeout)
}

// scpFile copies localPath into the VM at remotePath over an ordinary SSH
// session (stdin piped into `cat`), avoiding a dependency on a separate
// SFTP/SCP library for what's a single small file (a recipe.json).
func scpFile(client *ssh.Client, localPath, remotePath string) error {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	if err := session.Start("cat > " + remotePath); err != nil {
		return err
	}
	if _, err := stdin.Write(data); err != nil {
		return err
	}
	stdin.Close()
	return session.Wait()
}

// runRemote runs script on the VM via bash -s, streaming combined
// stdout+stderr to onLine line by line — the actual progress feed the UI
// shows during package install and the tacklebox build itself. stdout and
// stderr are read concurrently (two real OS pipes, not one merged stream —
// SSH sessions don't offer that), so onLine may interleave the two; that's
// fine for a log view, ordering within each stream is preserved.
func runRemote(client *ssh.Client, script string, onLine func(string)) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()

	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return err
	}

	if err := session.Start("bash -s"); err != nil {
		return err
	}
	if _, err := stdin.Write([]byte(script)); err != nil {
		return err
	}
	stdin.Close()

	var wg sync.WaitGroup
	var mu sync.Mutex
	streamLines := func(r io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			mu.Lock()
			onLine(scanner.Text())
			mu.Unlock()
		}
	}
	wg.Add(2)
	go streamLines(stdout)
	go streamLines(stderr)
	wg.Wait()

	return session.Wait()
}
