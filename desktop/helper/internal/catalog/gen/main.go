// Command gen copies the website catalog documents into the helper's embedded
// fallback directory. Run through `go generate ./...` in desktop/helper.
//
//	go run ./gen <app/public dir> <embedded dir>
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

var files = []string{"catalog-snapshot.json", "builder-config.json", "guided-catalog.json"}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gen <app/public dir> <embedded dir>")
		os.Exit(2)
	}
	src, dst := os.Args[1], os.Args[2]
	if err := os.MkdirAll(dst, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.WriteFile(filepath.Join(dst, name), b, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
