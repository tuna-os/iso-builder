package main

import "testing"

// TestFilterSafeDrivesWindows_RealShapedFixtures mirrors the Linux and
// macOS packages' safety-filter tests: reject the internal system disk,
// accept a real removable USB stick. Shaped like actual
// Get-CimInstance Win32_DiskDrive output fields.
func TestFilterSafeDrivesWindows_RealShapedFixtures(t *testing.T) {
	drives := []win32DiskDrive{
		{
			DeviceID: `\\.\PHYSICALDRIVE0`, Model: "Samsung SSD 980 1TB",
			Size: 1000204886016, InterfaceType: "SCSI", MediaType: "Fixed hard disk media",
		},
		{
			DeviceID: `\\.\PHYSICALDRIVE2`, Model: "Generic Flash Disk USB Device",
			Size: 32000000000, InterfaceType: "USB", MediaType: "Removable Media",
		},
	}
	safe := filterSafeDrivesWindows(drives)
	if len(safe) != 1 {
		t.Fatalf("expected exactly 1 safe drive, got %d: %+v", len(safe), safe)
	}
	if safe[0].Path != `\\.\PHYSICALDRIVE2` {
		t.Errorf("expected PHYSICALDRIVE2 to be the safe drive, got %s", safe[0].Path)
	}
}

func TestFilterSafeDrivesWindows_RejectsNonUSBInterface(t *testing.T) {
	drives := []win32DiskDrive{
		{DeviceID: `\\.\PHYSICALDRIVE1`, Size: 32000000000, InterfaceType: "IDE", MediaType: "Removable Media"},
	}
	if safe := filterSafeDrivesWindows(drives); len(safe) != 0 {
		t.Fatalf("non-USB interface must be rejected even if MediaType says removable, got %+v", safe)
	}
}

func TestFilterSafeDrivesWindows_RejectsFixedMedia(t *testing.T) {
	// A USB-interface fixed drive (some USB SSD enclosures report this)
	// should still be rejected — the point is media that behaves like
	// disposable removable storage, not just the bus type.
	drives := []win32DiskDrive{
		{DeviceID: `\\.\PHYSICALDRIVE3`, Size: 500000000000, InterfaceType: "USB", MediaType: "Fixed hard disk media"},
	}
	if safe := filterSafeDrivesWindows(drives); len(safe) != 0 {
		t.Fatalf("fixed media over USB must still be rejected, got %+v", safe)
	}
}

func TestParseWin32DiskDrives_SingleObjectNotArray(t *testing.T) {
	// PowerShell's ConvertTo-Json serializes a single match as a bare
	// object, not a one-element array — this is the exact bug shape that
	// breaks naive json.Unmarshal([]win32DiskDrive) on a machine with only
	// one disk.
	data := []byte(`{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Model":"Test","Size":1000,"InterfaceType":"SCSI","MediaType":"Fixed hard disk media","Index":0}`)
	drives, err := parseWin32DiskDrives(data)
	if err != nil {
		t.Fatalf("parseWin32DiskDrives: %v", err)
	}
	if len(drives) != 1 {
		t.Fatalf("expected 1 drive, got %d", len(drives))
	}
}

func TestParseWin32DiskDrives_Array(t *testing.T) {
	data := []byte(`[{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Size":1000},{"DeviceID":"\\\\.\\PHYSICALDRIVE1","Size":2000}]`)
	drives, err := parseWin32DiskDrives(data)
	if err != nil {
		t.Fatalf("parseWin32DiskDrives: %v", err)
	}
	if len(drives) != 2 {
		t.Fatalf("expected 2 drives, got %d", len(drives))
	}
}

func TestExtractVidPid(t *testing.T) {
	cases := map[string]string{
		`USB\VID_0951&PID_1666\E0D55EA6DC7C61114182`: "0951:1666",
		`SCSI\Disk&Ven_NVMe&Prod_Samsung`:             "",
	}
	for pnpID, want := range cases {
		if got := extractVidPid(pnpID); got != want {
			t.Errorf("extractVidPid(%q) = %q, want %q", pnpID, got, want)
		}
	}
}

func TestParseUsbipdBusID(t *testing.T) {
	listing := "BUSID  VID:PID    DEVICE                                                        STATE\n" +
		"1-3    0951:1666  Kingston DataTraveler 3.0 USB Device                          Not shared\n" +
		"2-1    046d:c52b  Logitech USB Receiver                                         Shared\n"
	got, err := parseUsbipdBusID(listing, "0951:1666")
	if err != nil {
		t.Fatalf("parseUsbipdBusID: %v", err)
	}
	if got != "1-3" {
		t.Errorf("got bus ID %q, want \"1-3\"", got)
	}

	if _, err := parseUsbipdBusID(listing, "ffff:ffff"); err == nil {
		t.Error("expected an error for a VID:PID not present in the listing")
	}
}

func TestToWSLPath(t *testing.T) {
	cases := map[string]string{
		`C:\Users\tbox\recipe.json`: "/mnt/c/Users/tbox/recipe.json",
		`D:\temp\x.json`:            "/mnt/d/temp/x.json",
		"already/a/unix/path":       "already/a/unix/path",
	}
	for in, want := range cases {
		if got := toWSLPath(in); got != want {
			t.Errorf("toWSLPath(%q) = %q, want %q", in, got, want)
		}
	}
}
