package main

import "testing"

func TestFilterCatalogByMetadata(t *testing.T) {
	images := []curatedImage{
		{Name: "Fedora GNOME", Base: "fedora", Desktop: "gnome", Architectures: []string{"amd64"}},
		{Name: "Debian KDE", Base: "debian", Desktop: "kde", Architectures: []string{"arm64"}},
	}
	got, err := filterCatalog(images, "base:fedora de:gnome arch:x86_64")
	if err != nil || len(got) != 1 || got[0].Name != "Fedora GNOME" {
		t.Fatalf("filtered catalog = %#v, err = %v", got, err)
	}
}

func TestFilterCatalogCustomURI(t *testing.T) {
	got, err := filterCatalog(nil, "oci://ghcr.io/tuna-os/bonito:gnome")
	if err != nil || len(got) != 1 || got[0].Image != "ghcr.io/tuna-os/bonito:gnome" {
		t.Fatalf("custom image = %#v, err = %v", got, err)
	}
}

func TestFilterCatalogRejectsInvalidCustomURI(t *testing.T) {
	if _, err := filterCatalog(nil, "oci://not-an-image"); err == nil {
		t.Fatal("expected malformed custom image URI to be rejected")
	}
}
