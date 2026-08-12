package main

import "testing"

func TestSelectionIsCurrentRejectsLateProbe(t *testing.T) {
	if selectionIsCurrent("/dev/sdb", "/dev/sdc", 4, 5) {
		t.Fatal("a probe from a previous selection must be rejected")
	}
	if selectionIsCurrent("/dev/sdb", "/dev/sdb", 4, 5) {
		t.Fatal("an old epoch must be rejected even when the path is reused")
	}
}

func TestSelectionIsCurrentAcceptsMatchingProbe(t *testing.T) {
	if !selectionIsCurrent("/dev/sdb", "/dev/sdb", 7, 7) {
		t.Fatal("the current selection should accept its matching probe")
	}
}

func TestSelectionIsCurrentRejectsEmptyPaths(t *testing.T) {
	if selectionIsCurrent("", "", 1, 1) {
		t.Fatal("empty paths cannot identify a write target")
	}
}
