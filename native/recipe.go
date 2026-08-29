package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// writeTempRecipe owns the temporary tacklebox input bundle. Keeping recipe
// serialization outside the Fyne entrypoint makes this privileged boundary
// independently testable and keeps main.go focused on application wiring.
func writeTempRecipe(img curatedImage, persistent bool) (string, error) {
	dir, err := os.MkdirTemp("", "tacklebox-recipe-")
	if err != nil {
		return "", err
	}
	recipePath := filepath.Join(dir, "recipe.json")
	if err := writeLiveOverlayScript(filepath.Join(dir, "live-overlay.sh"), img.Base, img.Desktop); err != nil {
		cleanupTempRecipe(recipePath)
		return "", err
	}

	envID := filepath.Base(img.Image)
	sharedStore, modes := "", `["live"]`
	if persistent {
		sharedStore = "\n  \"shared_store\": {\"format\": \"ext4\"},"
		modes = `["live", "persistent"]`
	}
	recipe := fmt.Sprintf(`{
  "media_name": "TUNAOS",
  "size": "16G",%s
  "bootable_environments": [
    {"id": %q, "image": %q, "title": %q, "desktop": %q, "backend": "bootc", "modes": %s, "live_customize": ["live-overlay.sh"]}
  ]
}`, sharedStore, envID, img.Image, img.Name, img.Desktop, modes)

	if err := os.WriteFile(recipePath, []byte(recipe), 0600); err != nil {
		cleanupTempRecipe(recipePath)
		return "", err
	}
	return recipePath, nil
}

func cleanupTempRecipe(recipePath string) {
	if recipePath == "" || filepath.Base(recipePath) != "recipe.json" {
		return
	}
	_ = os.RemoveAll(filepath.Dir(recipePath))
}

func writeLiveOverlayScript(path, base, desktop string) error {
	packages := map[string]string{
		"gnome": "gnome-shell", "kde": "plasma-desktop", "cosmic": "cosmic-session",
		"niri": "niri", "xfce": "xfce-desktop",
	}
	pack := packages[strings.ToLower(desktop)]
	var b strings.Builder
	b.WriteString("#!/bin/sh\nset -u\n")
	b.WriteString("BASE=" + shellQuote(base) + "\nDESKTOP=" + shellQuote(desktop) + "\n")
	b.WriteString("mkdir -p /etc/tunaos || true\n")
	b.WriteString("printf 'base=%s\\ndesktop=%s\\nsource=iso-builder-best-effort\\n' \"$BASE\" \"$DESKTOP\" > /etc/tunaos/live-overlay.conf || true\n")
	b.WriteString("warn() { echo \"live-overlay: $*\" >&2; }\n")
	if pack != "" {
		b.WriteString("case \"$BASE\" in\n")
		b.WriteString("fedora|centos|rhel|almalinux|yellowfin|bonito|skipjack|albacore) command -v dnf >/dev/null 2>&1 && dnf -y install " + pack + " || warn 'dnf could not install the requested desktop' ;;\n")
		b.WriteString("debian|ubuntu|flounder|grouper) command -v apt-get >/dev/null 2>&1 && apt-get install -y " + pack + " || warn 'apt-get could not install the requested desktop' ;;\n")
		b.WriteString("arch|marlin) command -v pacman >/dev/null 2>&1 && pacman -S --noconfirm " + pack + " || warn 'pacman could not install the requested desktop' ;;\n")
		b.WriteString("*) warn \"no package-manager mapping for base $BASE\" ;;\nesac\n")
	}
	b.WriteString("exit 0\n")
	return os.WriteFile(path, []byte(b.String()), 0755)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
