package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestNativeAndWebLoadSharedCatalogSnapshot(t *testing.T) {
	nativeRaw, err := catalogAssetsFS.ReadFile("catalog-snapshot.json")
	if err != nil {
		t.Fatalf("read embedded native catalog-snapshot.json: %v", err)
	}
	webRaw, err := os.ReadFile("../app/public/catalog-snapshot.json")
	if err != nil {
		t.Fatalf("read web ../app/public/catalog-snapshot.json: %v", err)
	}
	if !bytes.Equal(nativeRaw, webRaw) {
		t.Fatal("native/catalog-snapshot.json and app/public/catalog-snapshot.json differ; both loaders must share the exact CatalogSnapshot v1 document")
	}

	doc, err := loadEmbeddedCatalogSnapshot()
	if err != nil {
		t.Fatalf("loadEmbeddedCatalogSnapshot() failed: %v", err)
	}
	if doc.SchemaVersion != 1 || doc.Kind != "catalog-snapshot" {
		t.Fatalf("unexpected header: schemaVersion=%d kind=%q", doc.SchemaVersion, doc.Kind)
	}
	if !strings.HasPrefix(doc.CoverageDigest, "sha256:") || len(doc.CoverageDigest) != 71 {
		t.Errorf("invalid coverageDigest: %q", doc.CoverageDigest)
	}
	if !strings.HasPrefix(doc.SnapshotDigest, "sha256:") || len(doc.SnapshotDigest) != 71 {
		t.Errorf("invalid snapshotDigest: %q", doc.SnapshotDigest)
	}
	if len(doc.Targets) == 0 {
		t.Fatal("snapshot contains zero targets")
	}
	if len(variants) == 0 {
		t.Fatal("loadVariantsFromSnapshot produced zero variants")
	}
}

func TestWebAndNativeCatalogLoadersPreserveVariantFlavorPlatformCoverage(t *testing.T) {
	doc, err := loadEmbeddedCatalogSnapshot()
	if err != nil {
		t.Fatalf("loadEmbeddedCatalogSnapshot: %v", err)
	}

	// Evaluate the web loader directly in Node against ../app/public/catalog.js,
	// ../app/public/app.js, and ../app/public/catalog-snapshot.json so we test
	// the actual browser catalog boundary rather than regex-scraping source text.
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node runtime required for web catalog loader behavioral test: %v", err)
	}
	// Reading both scripts also makes them inputs to go test's result cache.
	catalogJS, err := os.ReadFile("../app/public/catalog.js")
	if err != nil {
		t.Fatalf("read web catalog boundary: %v", err)
	}
	appJS, err := os.ReadFile("../app/public/app.js")
	if err != nil {
		t.Fatalf("read web application: %v", err)
	}
	webJS := append(catalogJS, '\n')
	webJS = append(webJS, appJS...)
	webJS = append(webJS, '\n')

	script := `
const fs = require("fs");
const vm = require("vm");
const snap = JSON.parse(fs.readFileSync("../app/public/catalog-snapshot.json", "utf8"));
const code = fs.readFileSync(0, "utf8");

const elements = new Map();
function makeEl(id) {
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    href: "",
    dataset: {},
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    append() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}
const sandbox = {
  console,
  URL,
  URLSearchParams,
  Headers,
  Blob,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  performance: { now: () => 0 },
  location: { search: "", origin: "http://127.0.0.1:8931", pathname: "/" },
  navigator: { clipboard: { writeText: async () => {} }, storage: {} },
  document: {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement(tag) { return makeEl(tag); },
  },
  Option: function(text, value) { this.text = text; this.value = value; },
  fetch: async (url) => {
    if (String(url).includes("catalog-snapshot.json")) {
      return { ok: true, json: async () => snap };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + "\n;globalThis.__variants = VARIANTS; globalThis.__findCatalogEntry = findCatalogEntry; globalThis.__loadCatalogSnapshot = loadCatalogSnapshot;", sandbox);

(async () => {
  const loadedSnap = await sandbox.__loadCatalogSnapshot();
  const variants = sandbox.__variants.map((v) => ({
    id: v.id,
    name: v.name,
    desktops: v.des,
    platforms: {},
  }));
  for (const v of variants) {
    for (const de of v.desktops) {
      const plats = [];
      for (const p of ["linux/amd64", "linux/amd64/v2", "linux/arm64"]) {
        const entry = sandbox.__findCatalogEntry(v.id, de, p);
        if (entry && (entry.scheduled || (entry.availability && entry.availability.available))) {
          if (!plats.includes(entry.target.platform)) plats.push(entry.target.platform);
        }
      }
      v.platforms[de] = plats;
    }
  }
  process.stdout.write(JSON.stringify({
    snapshotDigest: loadedSnap.snapshotDigest,
    coverageDigest: loadedSnap.coverageDigest,
    targetCount: loadedSnap.targets.length,
    variants,
  }));
})();
`
	cmd := exec.Command(nodePath, "-e", script)
	cmd.Stdin = bytes.NewReader(webJS)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node web catalog evaluation failed: %v\n%s", err, string(out))
	}

	var web struct {
		SnapshotDigest string `json:"snapshotDigest"`
		CoverageDigest string `json:"coverageDigest"`
		TargetCount    int    `json:"targetCount"`
		Variants       []struct {
			ID        string              `json:"id"`
			Name      string              `json:"name"`
			Desktops  []string            `json:"desktops"`
			Platforms map[string][]string `json:"platforms"`
		} `json:"variants"`
	}
	if err := json.Unmarshal(out, &web); err != nil {
		t.Fatalf("unmarshal web loader output: %v\nraw: %s", err, string(out))
	}

	if web.SnapshotDigest != doc.SnapshotDigest {
		t.Errorf("snapshotDigest mismatch: web=%q native=%q", web.SnapshotDigest, doc.SnapshotDigest)
	}
	if web.CoverageDigest != doc.CoverageDigest {
		t.Errorf("coverageDigest mismatch: web=%q native=%q", web.CoverageDigest, doc.CoverageDigest)
	}
	if web.TargetCount != len(doc.Targets) {
		t.Errorf("target count mismatch: web=%d native=%d", web.TargetCount, len(doc.Targets))
	}

	if len(web.Variants) != len(variants) {
		t.Fatalf("variant count differs: web=%d native=%d", len(web.Variants), len(variants))
	}

	nativeCurated := buildCuratedImages()
	curatedByRef := make(map[string]curatedImage, len(nativeCurated))
	for _, img := range nativeCurated {
		curatedByRef[img.Base+":"+img.Desktop] = img
	}

	for i, wv := range web.Variants {
		nv := variants[i]
		if wv.ID != nv.id {
			t.Errorf("variant[%d] id: web=%q native=%q", i, wv.ID, nv.id)
			continue
		}
		if wv.Name != nv.name {
			t.Errorf("variant %s name: web=%q native=%q", wv.ID, wv.Name, nv.name)
		}
		if !slices.Equal(wv.Desktops, nv.desktops) {
			t.Errorf("variant %s desktops: web=%v native=%v", wv.ID, wv.Desktops, nv.desktops)
			continue
		}
		for _, de := range nv.desktops {
			key := nv.id + ":" + de
			img, ok := curatedByRef[key]
			if !ok {
				t.Errorf("missing native curatedImage for %s", key)
				continue
			}
			var expectedPlatforms, expectedArchitectures []string
			for _, entry := range doc.Targets {
				if entry.Target.Variant != nv.id || entry.Target.Flavor != de ||
					(!entry.Scheduled && !entry.Availability.Available) {
					continue
				}
				if !slices.Contains(expectedPlatforms, entry.Target.Platform) {
					expectedPlatforms = append(expectedPlatforms, entry.Target.Platform)
				}
				if !slices.Contains(expectedArchitectures, entry.Availability.OCIPlatform.Architecture) {
					expectedArchitectures = append(expectedArchitectures, entry.Availability.OCIPlatform.Architecture)
				}
			}
			if !slices.Equal(wv.Platforms[de], expectedPlatforms) {
				t.Errorf("%s web platforms=%v, snapshot=%v", key, wv.Platforms[de], expectedPlatforms)
			}
			if !slices.Equal(img.Platforms, expectedPlatforms) {
				t.Errorf("%s native platforms=%v, snapshot=%v", key, img.Platforms, expectedPlatforms)
			}
			if !slices.Equal(img.Architectures, expectedArchitectures) {
				t.Errorf("%s native architectures=%v, snapshot=%v", key, img.Architectures, expectedArchitectures)
			}
		}
	}
}

func TestCuratedAndExternalCatalogQualificationLabels(t *testing.T) {
	tuna := buildCuratedImages()
	if len(tuna) == 0 {
		t.Fatal("buildCuratedImages returned zero entries")
	}
	for _, img := range tuna {
		if img.External {
			t.Errorf("TunaOS curated image %q marked External=true", img.Image)
		}
		if img.Org != "TunaOS" {
			t.Errorf("TunaOS curated image %q has Org=%q, want TunaOS", img.Image, img.Org)
		}
		if !strings.HasPrefix(img.Image, "ghcr.io/tuna-os/") {
			t.Errorf("TunaOS curated image %q does not use ghcr.io/tuna-os/", img.Image)
		}
		if !slices.Contains([]string{"qualified", "local-only", "unqualified", "unsupported"}, img.QualificationStatus) {
			t.Errorf("TunaOS curated image %q has invalid qualification status %q", img.Image, img.QualificationStatus)
		}
	}

	ext := buildExternalCatalog()
	if len(ext) == 0 {
		t.Fatal("buildExternalCatalog returned zero entries")
	}
	for _, img := range ext {
		if !img.External {
			t.Errorf("external reference image %q must have External=true", img.Image)
		}
		if img.QualificationStatus != "unqualified" {
			t.Errorf("external reference image %q has QualificationStatus=%q, want unqualified", img.Image, img.QualificationStatus)
		}
		if strings.HasPrefix(img.Image, "ghcr.io/tuna-os/") {
			t.Errorf("external reference image %q unexpectedly points to ghcr.io/tuna-os/", img.Image)
		}
	}

}

func TestCatalogSnapshotDigest(t *testing.T) {
	// The shared snapshot serializes object keys in canonical sorted order.
	raw, err := catalogAssetsFS.ReadFile("catalog-snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	var rawDoc struct {
		SnapshotDigest string          `json:"snapshotDigest"`
		Targets        json.RawMessage `json:"targets"`
	}
	if err := json.Unmarshal(raw, &rawDoc); err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, rawDoc.Targets); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(compact.Bytes())
	wantDigest := "sha256:" + hex.EncodeToString(sum[:])
	if rawDoc.SnapshotDigest != wantDigest {
		t.Errorf("snapshotDigest = %q, canonical targets sha256 = %q", rawDoc.SnapshotDigest, wantDigest)
	}
}
