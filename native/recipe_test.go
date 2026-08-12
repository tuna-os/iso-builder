package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteTempRecipeDefaultsToPersistentMultiBoot(t *testing.T) {
	path, err := writeTempRecipe(curatedImage{
		Name: "Fedora GNOME", Image: "ghcr.io/tuna-os/bonito:gnome", Base: "bonito", Desktop: "gnome",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupTempRecipe(path)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var recipe struct {
		SharedStore          map[string]string `json:"shared_store"`
		BootableEnvironments []struct {
			Modes         []string `json:"modes"`
			LiveCustomize []string `json:"live_customize"`
		} `json:"bootable_environments"`
	}
	if err := json.Unmarshal(data, &recipe); err != nil {
		t.Fatal(err)
	}
	if recipe.SharedStore["format"] != "ext4" || len(recipe.BootableEnvironments) != 1 {
		t.Fatalf("persistent recipe = %s", data)
	}
	if strings.Join(recipe.BootableEnvironments[0].Modes, ",") != "live,persistent" {
		t.Fatalf("modes = %#v", recipe.BootableEnvironments[0].Modes)
	}
	if len(recipe.BootableEnvironments[0].LiveCustomize) != 1 {
		t.Fatalf("live customization missing: %#v", recipe.BootableEnvironments[0].LiveCustomize)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), recipe.BootableEnvironments[0].LiveCustomize[0])); err != nil {
		t.Fatalf("live overlay script missing: %v", err)
	}
}

func TestWriteTempRecipeInstallerModeIsNotPersistent(t *testing.T) {
	path, err := writeTempRecipe(curatedImage{Name: "Custom", Image: "oci.example/os:latest", Base: "custom", Desktop: "unknown"}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupTempRecipe(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "shared_store") || !strings.Contains(string(data), `"modes": ["live"]`) {
		t.Fatalf("installer recipe unexpectedly persistent: %s", data)
	}
}
