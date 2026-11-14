package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeBin installs an executable shell script named name in a fresh temp dir
// that replaces PATH for the test, so the code under test reaches the shim
// instead of the real lsblk/sudo/tacklebox. It returns the dir. Only the
// shims are on PATH (they use only shell builtins), so a missing shim fails
// the test instead of falling through to a real binary on the host.
func fakeBin(t *testing.T, shims map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range shims {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	return dir
}

// A realistic `lsblk -J -b` tree: an internal NVMe system disk with a mounted
// root, a USB stick that GNOME auto-mounted, and a loop device. Only the
// stick may come back, and only through the real JSON decoder.
const lsblkFixture = `{
  "blockdevices": [
    {"name":"nvme0n1","model":"Samsung SSD 980","size":1000204886016,"type":"disk","rm":false,"ro":false,"hotplug":false,"tran":"nvme","mountpoint":null,
     "children":[
       {"name":"nvme0n1p1","model":null,"size":536870912,"type":"part","rm":false,"ro":false,"hotplug":false,"tran":null,"mountpoint":"/boot/efi"},
       {"name":"nvme0n1p2","model":null,"size":999666009088,"type":"part","rm":false,"ro":false,"hotplug":false,"tran":null,"mountpoint":"/"}
     ]},
    {"name":"sdb","model":"Generic Flash Disk","size":32000000000,"type":"disk","rm":true,"ro":false,"hotplug":true,"tran":"usb","mountpoint":null,
     "children":[
       {"name":"sdb1","model":null,"size":32000000000,"type":"part","rm":true,"ro":false,"hotplug":true,"tran":null,"mountpoint":"/run/media/user/TUNA"}
     ]},
    {"name":"loop0","model":null,"size":1000000,"type":"loop","rm":false,"ro":true,"hotplug":false,"tran":null,"mountpoint":"/var/lib/snapd/snap/core/1"}
  ]
}`

func TestSafeWriteTargets_DecodesRealLsblkOutput(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	fakeBin(t, map[string]string{
		"lsblk": "printf '%s\\n' \"$@\" > " + argsFile + "\nprintf '%s\\n' '" + lsblkFixture + "'\n",
	})

	got, err := SafeWriteTargets()
	if err != nil {
		t.Fatalf("SafeWriteTargets: %v", err)
	}
	want := []Drive{{Path: "/dev/sdb", Model: "Generic Flash Disk", Size: 32000000000, SizeH: humanSize(32000000000)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SafeWriteTargets = %+v, want %+v", got, want)
	}

	// The decoder only works if lsblk is asked for JSON, bytes, and every
	// column lsblkDevice reads. Dropping one silently empties the list.
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Fields(string(raw))
	wantArgs := []string{"-J", "-b", "-o", "NAME,MODEL,SIZE,TYPE,RM,RO,HOTPLUG,TRAN,MOUNTPOINT"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("lsblk args = %q, want %q", args, wantArgs)
	}
}

func TestSafeWriteTargets_NoDrives(t *testing.T) {
	fakeBin(t, map[string]string{"lsblk": `echo '{"blockdevices": []}'`})
	got, err := SafeWriteTargets()
	if err != nil {
		t.Fatalf("SafeWriteTargets: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no drives, got %+v", got)
	}
}

func TestSafeWriteTargets_LsblkFailureIsWrapped(t *testing.T) {
	fakeBin(t, map[string]string{"lsblk": "exit 32"})
	got, err := SafeWriteTargets()
	if err == nil || !strings.HasPrefix(err.Error(), "lsblk: ") {
		t.Fatalf("want a %q-prefixed error, got drives=%+v err=%v", "lsblk: ", got, err)
	}
	if got != nil {
		t.Fatalf("no drives may be offered when lsblk fails, got %+v", got)
	}
}

func TestSafeWriteTargets_MissingLsblk(t *testing.T) {
	fakeBin(t, nil)
	if _, err := SafeWriteTargets(); err == nil || !strings.HasPrefix(err.Error(), "lsblk: ") {
		t.Fatalf("want a %q-prefixed error, got %v", "lsblk: ", err)
	}
}

func TestSafeWriteTargets_MalformedJSONIsWrapped(t *testing.T) {
	fakeBin(t, map[string]string{"lsblk": `echo '{"blockdevices": [`})
	got, err := SafeWriteTargets()
	if err == nil || !strings.HasPrefix(err.Error(), "parse lsblk output: ") {
		t.Fatalf("want a %q-prefixed error, got drives=%+v err=%v", "parse lsblk output: ", got, err)
	}
	if got != nil {
		t.Fatalf("no drives may be offered when output is malformed, got %+v", got)
	}
}

func TestTackleboxPath_FallsBackToAbsolutePathLookup(t *testing.T) {
	dir := fakeBin(t, map[string]string{"tacklebox": "exit 0"})
	// A tacklebox beside the test binary would win; the test binary lives in
	// a temp build dir, so none is expected, but skip rather than lie.
	if exe, err := os.Executable(); err == nil {
		if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "tacklebox")); err == nil {
			t.Skip("tacklebox next to test binary")
		}
	}
	want := filepath.Join(dir, "tacklebox")
	if got := tackleboxPath(); got != want {
		t.Fatalf("tackleboxPath() = %q, want absolute %q (sudo drops the caller's PATH)", got, want)
	}
}

func TestTackleboxPath_BareNameWhenNotFound(t *testing.T) {
	fakeBin(t, nil)
	if exe, err := os.Executable(); err == nil {
		if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "tacklebox")); err == nil {
			t.Skip("tacklebox next to test binary")
		}
	}
	if got := tackleboxPath(); got != "tacklebox" {
		t.Fatalf("tackleboxPath() = %q, want bare %q", got, "tacklebox")
	}
}

// sudoShim records its argv (one per line) and then prints two lines, one on
// stdout and one on stderr, and exits with $SUDO_RC (default 0).
func sudoShim(argsFile string) string {
	return "printf '%s\\n' \"$@\" > " + argsFile + "\n" +
		"echo out-line\necho err-line >&2\nexit ${SUDO_RC:-0}\n"
}

func TestExecuteTacklebox_RunsThroughSudoAndStreamsOutput(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	dir := fakeBin(t, map[string]string{"sudo": sudoShim(argsFile), "tacklebox": "exit 0"})

	var lines []string
	if err := executeTacklebox("build", "/tmp/recipe.yaml", "/dev/sdb", func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatalf("executeTacklebox: %v", err)
	}

	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "tacklebox"), "build", "--yes", "/tmp/recipe.yaml", "/dev/sdb"}
	if got := strings.Fields(string(raw)); !reflect.DeepEqual(got, want) {
		t.Fatalf("sudo argv = %q, want %q", got, want)
	}

	// stderr is merged into the same stream so the UI log sees failures.
	if len(lines) != 2 || lines[0] != "out-line" || lines[1] != "err-line" {
		t.Fatalf("streamed lines = %q, want [out-line err-line]", lines)
	}
}

func TestExecuteTacklebox_PropagatesNonZeroExit(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	fakeBin(t, map[string]string{"sudo": sudoShim(argsFile)})
	t.Setenv("SUDO_RC", "3")

	var lines []string
	err := executeTacklebox("add", "r.yaml", "/dev/sdb", func(l string) { lines = append(lines, l) })
	if err == nil {
		t.Fatal("a failing tacklebox must surface as an error, got nil")
	}
	if len(lines) != 2 {
		t.Fatalf("output before the failure must still be streamed, got %q", lines)
	}
}

func TestRunTackleboxArgs_UsesCallerArgumentShape(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	dir := fakeBin(t, map[string]string{"sudo": sudoShim(argsFile), "tacklebox": "exit 0"})

	// remove has no recipe: `remove <env-id> <drive> --yes`.
	err := runTackleboxArgs("/dev/sdb", func(device string) []string {
		return []string{"remove", "env-1", device, "--yes"}
	}, func(string) {})
	if err != nil {
		t.Fatalf("runTackleboxArgs: %v", err)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "tacklebox"), "remove", "env-1", "/dev/sdb", "--yes"}
	if got := strings.Fields(string(raw)); !reflect.DeepEqual(got, want) {
		t.Fatalf("sudo argv = %q, want %q", got, want)
	}
}

func TestRunTackleboxArgs_StartFailure(t *testing.T) {
	fakeBin(t, nil) // no sudo on PATH
	err := runTackleboxArgs("/dev/sdb", func(d string) []string { return []string{"verify", d} }, func(string) {})
	if err == nil {
		t.Fatal("missing sudo must be an error, got nil")
	}
}

func TestIsManagedDrive(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	dir := fakeBin(t, map[string]string{"sudo": sudoShim(argsFile), "tacklebox": "exit 0"})

	managed, out := isManagedDrive("/dev/sdb")
	if !managed {
		t.Fatalf("exit 0 from `tacklebox status` means managed; out=%q", out)
	}
	if !strings.Contains(out, "out-line") {
		t.Fatalf("output must be returned for the caller to surface, got %q", out)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "tacklebox"), "status", "/dev/sdb"}
	if got := strings.Fields(string(raw)); !reflect.DeepEqual(got, want) {
		t.Fatalf("sudo argv = %q, want %q", got, want)
	}

	// A blank or foreign drive makes `status` fail; that must read as
	// "not managed" (so the app never defaults to managing a stranger's
	// disk), with the failure text still returned.
	t.Setenv("SUDO_RC", "1")
	managed, out = isManagedDrive("/dev/sdb")
	if managed {
		t.Fatal("non-zero exit from `tacklebox status` must mean not managed")
	}
	if !strings.Contains(out, "err-line") {
		t.Fatalf("failure output must be returned, got %q", out)
	}
}
