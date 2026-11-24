package safedrives

import "testing"

// Union of the native writer's and the helper's Windows fixtures (shaped
// like Get-CimInstance Win32_DiskDrive output).
func TestFilterWindows(t *testing.T) {
	disks := []WinDisk{
		{DeviceID: `\\.\PHYSICALDRIVE0`, Model: "Samsung SSD 980 1TB", Size: 1000204886016, InterfaceType: "SCSI", MediaType: "Fixed hard disk media", Index: 0},
		{DeviceID: `\\.\PHYSICALDRIVE1`, Size: 32000000000, InterfaceType: "IDE", MediaType: "Removable Media", Index: 1},
		{DeviceID: `\\.\PHYSICALDRIVE2`, Model: "Generic Flash Disk USB Device ", Size: 32000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 2, SerialNumber: " 0123ABC "},
		{DeviceID: `\\.\PHYSICALDRIVE3`, Size: 500000000000, InterfaceType: "USB", MediaType: "Fixed hard disk media", Index: 3},
		{DeviceID: `\\.\PHYSICALDRIVE4`, Size: 0, InterfaceType: "USB", MediaType: "Removable Media", Index: 4},
		{DeviceID: `\\.\PHYSICALDRIVE5`, Size: 16000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 5},
	}
	// Disk 5 is excluded (system disk / ISO's disk): only disk 2 is offered.
	safe := FilterWindows(disks, map[int]bool{5: true})
	if len(safe) != 1 || safe[0].Path != `\\.\PHYSICALDRIVE2` || safe[0].DiskNumber != 2 ||
		safe[0].Ident != "0123ABC" || safe[0].Name != "Generic Flash Disk USB Device" {
		t.Fatalf("got %+v", safe)
	}
}

func TestFilterWindowsRejectsNonUSB(t *testing.T) {
	disks := []WinDisk{
		{DeviceID: `\\.\PHYSICALDRIVE1`, Size: 32000000000, InterfaceType: "IDE", MediaType: "Removable Media"},
	}
	if safe := FilterWindows(disks, nil); len(safe) != 0 {
		t.Fatalf("non-USB interface must be rejected even if MediaType says removable, got %+v", safe)
	}
}

func TestFilterWindowsExcludedSystemDisk(t *testing.T) {
	// A USB disk that holds the running system is still rejected once its
	// disk number is excluded (Windows To Go / installer booted from USB).
	disks := []WinDisk{
		{DeviceID: `\\.\PHYSICALDRIVE1`, Model: "USB System Disk", Size: 32000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 1},
		{DeviceID: `\\.\PHYSICALDRIVE2`, Model: "Target Stick", Size: 16000000000, InterfaceType: "USB", MediaType: "Removable Media", Index: 2},
	}
	safe := FilterWindows(disks, map[int]bool{1: true})
	if len(safe) != 1 || safe[0].Path != `\\.\PHYSICALDRIVE2` {
		t.Fatalf("got %+v", safe)
	}
}

func TestParseWin32DiskDrives(t *testing.T) {
	one, err := ParseWin32DiskDrives([]byte(`{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Model":"Test","Size":1000,"InterfaceType":"SCSI","MediaType":"Fixed hard disk media","Index":0,"SerialNumber":null}`))
	if err != nil || len(one) != 1 || one[0].DeviceID != `\\.\PHYSICALDRIVE0` {
		t.Fatalf("single object: %v %+v", err, one)
	}
	many, err := ParseWin32DiskDrives([]byte(`[{"DeviceID":"\\\\.\\PHYSICALDRIVE0","Size":1000},{"DeviceID":"\\\\.\\PHYSICALDRIVE1","Size":2000,"Index":1}]`))
	if err != nil || len(many) != 2 || many[1].Index != 1 {
		t.Fatalf("array: %v %+v", err, many)
	}
	if none, err := ParseWin32DiskDrives([]byte("  \n")); err != nil || none != nil {
		t.Fatalf("empty: %v %+v", err, none)
	}
}
