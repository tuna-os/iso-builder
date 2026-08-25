package main

import (
	"os"
	"regexp"
	"testing"
)

// The Go `variants` table and the browser picker's VARIANTS array are the
// same list, maintained twice by hand — catalog.go says so in its own
// comment ("copied from ../app/public/app.js's VARIANTS array"). Its next
// sentence records why that matters: "the fabricated-image-list bug this
// replaced happened specifically because a hand-typed list wasn't checked
// against a source of truth until after the fact."
//
// Nothing checked the two copies against EACH OTHER. Adding a variant to
// one and not the other yields a native app and a web picker that offer
// different operating systems, with no test failing and nothing in either
// UI to suggest they disagree.
//
// This pins them together. It cannot tell you the list is RIGHT — for
// that it would have to read tunaOS's build-config.yml, which lives in
// another repository — but it does tell you the two copies say the same
// thing, which is the failure mode duplication actually produces.

var jsVariantRe = regexp.MustCompile(
	`\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*des:\s*\[([^\]]*)\]\s*\}`)

var jsDesktopRe = regexp.MustCompile(`"([^"]+)"`)

func parseJSVariants(t *testing.T) []variant {
	t.Helper()
	raw, err := os.ReadFile("../app/public/app.js")
	if err != nil {
		t.Fatalf("cannot read the browser picker: %v", err)
	}
	block := regexp.MustCompile(`(?s)const VARIANTS = \[(.*?)\];`).FindSubmatch(raw)
	if block == nil {
		t.Fatal("no `const VARIANTS = [...]` in app.js — the detector is broken, " +
			"not the data; fix this regex before trusting a pass")
	}
	var out []variant
	for _, m := range jsVariantRe.FindAllStringSubmatch(string(block[1]), -1) {
		var des []string
		for _, d := range jsDesktopRe.FindAllStringSubmatch(m[3], -1) {
			des = append(des, d[1])
		}
		out = append(out, variant{id: m[1], name: m[2], desktops: des})
	}
	return out
}

func TestCatalogMatchesTheBrowserPicker(t *testing.T) {
	js := parseJSVariants(t)

	if len(js) == 0 {
		t.Fatal("parsed zero variants from app.js — a green result here would " +
			"mean nothing was compared")
	}
	if len(js) != len(variants) {
		t.Fatalf("variant COUNT differs: app.js has %d, catalog.go has %d.\n"+
			"app.js: %v\ncatalog.go: %v", len(js), len(variants), ids(js), ids(variants))
	}

	for i := range js {
		if js[i].id != variants[i].id {
			t.Errorf("variant %d: app.js has %q, catalog.go has %q",
				i, js[i].id, variants[i].id)
			continue
		}
		if js[i].name != variants[i].name {
			t.Errorf("%s: name differs — app.js %q, catalog.go %q",
				js[i].id, js[i].name, variants[i].name)
		}
		if len(js[i].desktops) != len(variants[i].desktops) {
			t.Errorf("%s: desktop count differs — app.js %v, catalog.go %v",
				js[i].id, js[i].desktops, variants[i].desktops)
			continue
		}
		for d := range js[i].desktops {
			if js[i].desktops[d] != variants[i].desktops[d] {
				t.Errorf("%s desktop %d: app.js %q, catalog.go %q",
					js[i].id, d, js[i].desktops[d], variants[i].desktops[d])
			}
		}
	}
}

// A parser that silently matches nothing would make the test above pass
// for the wrong reason, so prove it can read a known entry.
func TestTheParserActuallyReadsEntries(t *testing.T) {
	js := parseJSVariants(t)
	found := false
	for _, v := range js {
		if v.id == "yellowfin" {
			found = true
			if len(v.desktops) == 0 {
				t.Error("yellowfin parsed with no desktops — the desktop regex is wrong")
			}
			if v.name == "" {
				t.Error("yellowfin parsed with no name — the name group is wrong")
			}
		}
	}
	if !found {
		t.Fatalf("parser did not find yellowfin; got %v", ids(js))
	}
}

func ids(vs []variant) []string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.id)
	}
	return out
}
