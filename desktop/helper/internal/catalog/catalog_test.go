package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func embeddedOrFail(t *testing.T) *Catalog {
	t.Helper()
	c, err := EmbeddedCatalog()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestModel(t *testing.T) {
	c := embeddedOrFail(t)
	ev := c.Model()
	if ev.Event != "catalog" || ev.SnapshotDigest != c.Snapshot.SnapshotDigest || len(ev.Targets) == 0 {
		t.Fatalf("event header %+v", ev)
	}
	// Facet order is builder-config's, and only desktops/bases with
	// selectable targets appear.
	order := map[string]int{}
	for _, f := range c.Config.Selection.Facets {
		for i, v := range f.Values {
			order[f.ID+"/"+v.ID] = i
		}
	}
	for i := 1; i < len(ev.Desktops); i++ {
		if order["desktop/"+ev.Desktops[i-1].ID] >= order["desktop/"+ev.Desktops[i].ID] {
			t.Fatalf("desktops out of facet order: %+v", ev.Desktops)
		}
	}
	for i := 1; i < len(ev.Bases); i++ {
		if order["base/"+ev.Bases[i-1].ID] >= order["base/"+ev.Bases[i].ID] {
			t.Fatalf("bases out of facet order: %+v", ev.Bases)
		}
	}
	seenDefault := false
	for _, tg := range ev.Targets {
		e, ok := c.Entry(tg.ID)
		if !ok || !e.Availability.Available {
			t.Fatalf("unavailable target listed: %s", tg.ID)
		}
		if tg.Desktop == "none" || tg.Desktop == "" || !SupportedPlatforms[tg.Platform] || tg.Image != e.Publication.Ref || tg.CompressedSize <= 0 {
			t.Fatalf("bad target %+v", tg)
		}
		seenDefault = seenDefault || tg.ID == ev.DefaultTarget
	}
	if !seenDefault || ev.DefaultTarget != c.Config.DefaultSelection.LeafID {
		t.Fatalf("default target %q not the configured selectable leaf", ev.DefaultTarget)
	}
	if t0 := ev.Targets[0]; t0.Desktop != ev.Desktops[0].ID || t0.Base != ev.Bases[0].ID {
		t.Fatalf("first target %+v does not follow facet order", t0)
	}
	if tg, ok := c.Lookup("skipjack:gnome:linux/amd64"); !ok || !tg.BrowserQualified || tg.Edition != "standard" || tg.Hardware != "generic" {
		t.Fatalf("skipjack:gnome qualified target: %+v %v", tg, ok)
	}
	if _, ok := c.Lookup("yellowfin:base:linux/amd64"); ok {
		t.Fatal("desktop-less base image offered")
	}
	b, _ := json.Marshal(ev.Targets[0])
	for _, k := range []string{"id", "base", "desktop", "platform", "edition", "hardware", "image", "compressedSize", "browserQualified"} {
		if !strings.Contains(string(b), `"`+k+`":`) {
			t.Fatalf("target JSON lacks %s: %s", k, b)
		}
	}
}

// A "qualified" status without complete provenance is not qualified (app.js
// catalogQualification).
func TestQualificationNeedsProvenance(t *testing.T) {
	c := embeddedOrFail(t)
	e, _ := c.Entry("skipjack:gnome:linux/amd64")
	if q := Qualification(e); q.Status != "qualified" || q.ReceiptDigest == "" {
		t.Fatalf("baseline: %+v", q)
	}
	mutate := func(f func(q map[string]any)) QualificationResult {
		cp := *e
		raw, _ := json.Marshal(e.Qualification)
		var q map[string]any
		_ = json.Unmarshal(raw, &q)
		f(q)
		cp.Qualification = q
		return Qualification(&cp)
	}
	for name, f := range map[string]func(map[string]any){
		"bad receipt digest": func(q map[string]any) { q["receiptDigest"] = "sha256:nope" },
		"impossible date":    func(q map[string]any) { q["qualifiedAt"] = "2026-02-30T00:00:00Z" },
		"native origin":      func(q map[string]any) { q["buildOrigin"] = "native" },
		"run id not integer": func(q map[string]any) { p, _ := q["producer"].(map[string]any); p["runId"] = 1.5 },
	} {
		if q := mutate(f); q.Status != "unqualified" {
			t.Errorf("%s: still %s", name, q.Status)
		}
	}
}

func TestFetchAndFallback(t *testing.T) {
	var docs [3][]byte
	for i, name := range Files {
		docs[i], _ = embedded.ReadFile("embedded/" + name)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i, name := range Files {
			if r.URL.Path == "/"+name {
				_, _ = w.Write(docs[i])
				return
			}
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	warned := ""
	warn := func(f string, a ...any) { warned = f }
	c, err := Load(context.Background(), srv.URL+"/", warn)
	if err != nil || c.Embedded || warned != "" {
		t.Fatalf("online load: %v embedded=%v warn=%q", err, c.Embedded, warned)
	}
	c, err = Load(context.Background(), srv.URL+"/missing", warn)
	if err != nil || !c.Embedded || warned == "" {
		t.Fatalf("fallback: %v embedded=%v warn=%q", err, c != nil && c.Embedded, warned)
	}
}

func TestParseRejectsUnboundGuidedCatalog(t *testing.T) {
	var docs [3][]byte
	for i, name := range Files {
		docs[i], _ = embedded.ReadFile("embedded/" + name)
	}
	g := strings.Replace(string(docs[2]), `"snapshotDigest": "sha256:`, `"snapshotDigest": "sha256:0`, 1)
	g = strings.Replace(g, `"snapshotDigest":"sha256:`, `"snapshotDigest":"sha256:0`, 1)
	if _, err := Parse(docs[0], docs[1], []byte(g)); err == nil {
		t.Fatal("guided catalog bound to another snapshot accepted")
	}
}

func TestValidFlatpakID(t *testing.T) {
	for id, want := range map[string]bool{
		"org.mozilla.firefox": true, "io.github.kolunmi.Bazaar": true, "com.mattjakeman.ExtensionManager": true,
		"firefox": false, "org.mozilla": false, "org.mozilla.fire fox": false, "../../etc": false,
	} {
		if ValidFlatpakID(id) != want {
			t.Errorf("ValidFlatpakID(%q) != %v", id, want)
		}
	}
}
