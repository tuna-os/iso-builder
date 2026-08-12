package main

import "testing"

func TestSelectionIsCurrentRejectsStaleDriveProbe(t *testing.T) {
	if selectionIsCurrent("/dev/sdb", "/dev/sdc", 4, 5) {
		t.Fatal("old path accepted")
	}
	if selectionIsCurrent("/dev/sdb", "/dev/sdb", 4, 5) {
		t.Fatal("old epoch accepted")
	}
}

func TestSelectionIsCurrentAcceptsCurrentDriveProbe(t *testing.T) {
	if !selectionIsCurrent("/dev/sdb", "/dev/sdb", 7, 7) {
		t.Fatal("current probe rejected")
	}
}

func TestSelectionIsCurrentRejectsEmptyPath(t *testing.T) {
	if selectionIsCurrent("", "", 1, 1) {
		t.Fatal("empty path accepted")
	}
}
