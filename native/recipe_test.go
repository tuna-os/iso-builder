package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteTempRecipeModes(t *testing.T) {
	img := curatedImage{Name: "Test OS", Image: "ghcr.io/example/test:latest", Base: "fedora", Desktop: "gnome"}
	for _, tc := range []struct {
		name       string
		persistent bool
		wantMode   string
		wantStore  bool
	}{
		{name: "installer", wantMode: `"modes":["live"]`},
		{name: "persistent", persistent: true, wantMode: `"modes":["live","persistent"]`, wantStore: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, err := writeTempRecipe(img, tc.persistent)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { cleanupTempRecipe(path) })
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var parsed map[string]any
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatalf("recipe is invalid JSON: %v", err)
			}
			compact := strings.ReplaceAll(string(raw), " ", "")
			compact = strings.ReplaceAll(compact, "\n", "")
			if !strings.Contains(compact, tc.wantMode) {
				t.Fatalf("recipe mode mismatch: %s", raw)
			}
			_, hasStore := parsed["shared_store"]
			if hasStore != tc.wantStore {
				t.Fatalf("shared_store present = %v, want %v", hasStore, tc.wantStore)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(path), "live-overlay.sh")); err != nil {
				t.Fatalf("overlay script missing: %v", err)
			}
		})
	}
}

func TestShellQuote(t *testing.T) {
	if got, want := shellQuote("it's"), `'it'\''s'`; got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}
