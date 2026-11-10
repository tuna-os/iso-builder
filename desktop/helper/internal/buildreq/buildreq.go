// Package buildreq constructs BuildRequest v1 documents for the tacklebox
// engine exactly as app/public/app.js buildRequestFromForm does when a user
// picks a catalog target in the guided picker (parity is pinned by fixtures
// generated from app.js itself: testdata/gen-fixtures.cjs).
package buildreq

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/tuna-os/iso-builder/desktop/helper/internal/catalog"
)

// DefaultRelay is the browser's CORS relay (app.js SHIM default). It fronts
// ghcr.io only.
const DefaultRelay = "https://relay.tunaos.org"

// DirectRegistry is what the relay fronts. A native process needs no CORS
// relay, so the helper fetches from it directly (see Native).
const DirectRegistry = "https://ghcr.io"

// Request is BuildRequest v1 with app.js's key order and field presence:
// customImage and the options lists are always present, resolvedInputs
// carries all seven keys (empty strings included) for catalog targets.
type Request struct {
	SchemaVersion   int             `json:"schemaVersion"`
	Kind            string          `json:"kind"`
	CustomImage     bool            `json:"customImage"`
	Image           string          `json:"image"`
	Registry        string          `json:"registry"`
	Target          *Target         `json:"target,omitempty"`
	ResolvedInputs  *ResolvedInputs `json:"resolvedInputs,omitempty"`
	Options         Options         `json:"options"`
	CatalogVersion  string          `json:"catalogVersion"`
	QualificationID string          `json:"qualificationId,omitempty"`
}

type Target struct {
	Variant       string `json:"variant"`
	Flavor        string `json:"flavor"`
	Platform      string `json:"platform"`
	CPUBaseline   string `json:"cpuBaseline"`
	HardwareScope string `json:"hardwareScope"`
}

type ResolvedInputs struct {
	PlatformManifestDigest string `json:"platformManifestDigest"`
	IndexDigest            string `json:"indexDigest"`
	ConfigDigest           string `json:"configDigest"`
	LiveOverlayDigest      string `json:"liveOverlayDigest"`
	LiveOverlayBaseDigest  string `json:"liveOverlayBaseDigest"`
	InstallerRevision      string `json:"installerRevision"`
	EngineRevision         string `json:"engineRevision"`
}

type Options struct {
	Label          string   `json:"label"`
	Packages       []string `json:"packages"`
	Flatpaks       []string `json:"flatpaks"`
	ExtraRun       []string `json:"extraRun"`
	OutputFilename string   `json:"outputFilename"`
}

var validPlatforms = map[string]bool{"linux/amd64": true, "linux/amd64/v2": true, "linux/amd64/v3": true, "linux/arm64": true}
var nativeV3Variants = map[string]bool{"skipjack": true, "wahoo": true}
var tunaPartRE = regexp.MustCompile(`^[a-z0-9-]+$`)
var labelRE = regexp.MustCompile(`[^A-Z0-9_]`)

// parseImage mirrors app.js parseImage with SHIM at its default.
func parseImage(raw string) (registry, image string) {
	s := strings.TrimSpace(raw)
	if !strings.Contains(s, "/") {
		s = "tuna-os/" + s
	}
	first := strings.SplitN(s, "/", 2)[0]
	if strings.ContainsAny(first, ".:") {
		rest := s[len(first)+1:]
		if first == "ghcr.io" {
			return DefaultRelay, rest
		}
		return "https://" + first, rest
	}
	return DefaultRelay, s
}

// canonicalInstallRef mirrors app.js canonicalInstallRef.
func canonicalInstallRef(raw, registry, image string) string {
	raw = strings.TrimSpace(raw)
	first := strings.SplitN(raw, "/", 2)[0]
	if strings.Contains(raw, "/") && strings.ContainsAny(first, ".:") {
		return raw
	}
	if registry == DefaultRelay {
		return "ghcr.io/" + image
	}
	return image
}

// parseCuratedTunaRef mirrors app.js parseCuratedTunaRef.
func parseCuratedTunaRef(raw string) (variant, flavor string, ok bool) {
	s := strings.TrimSpace(raw)
	if s == "" || !strings.Contains(s, ":") {
		return "", "", false
	}
	s = strings.TrimPrefix(s, "ghcr.io/")
	if strings.HasPrefix(s, "tuna-os/") {
		s = s[len("tuna-os/"):]
	} else if strings.Contains(s, "/") {
		return "", "", false
	}
	idx := strings.LastIndex(s, ":")
	if idx <= 0 || idx == len(s)-1 {
		return "", "", false
	}
	variant, flavor = s[:idx], s[idx+1:]
	if !tunaPartRE.MatchString(variant) || !tunaPartRE.MatchString(flavor) {
		return "", "", false
	}
	return variant, flavor, true
}

// normalizePlatformForVariant mirrors app.js.
func normalizePlatformForVariant(c *catalog.Catalog, variant, platform string) string {
	p := platform
	if !validPlatforms[p] {
		p = "linux/amd64"
	}
	if variant == "" {
		return p
	}
	published := false
	for _, e := range c.Snapshot.Targets {
		if e.Target.Variant == variant && e.Target.Platform == p {
			published = true
			break
		}
	}
	if !published && p == "linux/amd64/v2" {
		return "linux/amd64"
	}
	return p
}

func cpuBaselineForTarget(variant, platform string) string {
	switch {
	case platform == "linux/arm64":
		return "armv8-a"
	case platform == "linux/amd64/v2":
		return "x86-64-v2"
	case platform == "linux/amd64/v3", nativeV3Variants[variant]:
		return "x86-64-v3"
	}
	return "x86-64"
}

func hardwareScopeForFlavor(flavor string) string {
	for _, p := range strings.Split(flavor, "-") {
		if p == "asahi" {
			return "apple-silicon"
		}
	}
	for _, p := range strings.Split(flavor, "-") {
		if p == "t2" {
			return "apple-t2"
		}
	}
	return "generic"
}

func platformSlug(platform string) string {
	if platform == "" {
		platform = "linux/amd64"
	}
	return strings.ReplaceAll(strings.TrimPrefix(platform, "linux/"), "/", "-")
}

// findCatalogEntry mirrors app.js findCatalogEntry.
func findCatalogEntry(c *catalog.Catalog, variant, flavor, platform string) *catalog.Entry {
	norm := normalizePlatformForVariant(c, variant, platform)
	key := variant + ":" + flavor + ":" + norm
	for i := range c.Snapshot.Targets {
		e := &c.Snapshot.Targets[i]
		if e.TargetKey == key || (e.Target.Variant == variant && e.Target.Flavor == flavor && e.Target.Platform == norm) {
			return e
		}
	}
	ref := "ghcr.io/tuna-os/" + variant + ":" + flavor
	for i := range c.Snapshot.Targets {
		e := &c.Snapshot.Targets[i]
		if e.Publication.Ref == ref && e.Target.Platform == norm {
			return e
		}
	}
	return nil
}

// Form is the guided-picker state buildRequestFromForm reads.
type Form struct {
	Image    string // $("image").value: the leaf's publication ref
	Platform string // $("platform").value
	Label    string // $("label").value ("" = builder-config volume_label)
	Flatpaks []string
	Packages []string
	ExtraRun []string
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// FromForm is buildRequestFromForm for a form without a prior operation.
func FromForm(c *catalog.Catalog, f Form) *Request {
	raw := strings.TrimSpace(f.Image)
	registry, image := parseImage(raw)
	installImage := canonicalInstallRef(raw, registry, image)
	label := f.Label
	if label == "" {
		label = c.Config.Output.VolumeLabel
	}
	label = labelRE.ReplaceAllString(strings.ToUpper(label), "_")
	if label == "" {
		label = c.Config.Output.VolumeLabel
	}
	platform := f.Platform
	if !validPlatforms[platform] {
		platform = "linux/amd64"
	}
	variant, flavor, curated := parseCuratedTunaRef(raw)
	isBase := curated && (flavor == "base" || strings.HasPrefix(flavor, "base-"))
	plat := platform
	if curated {
		plat = normalizePlatformForVariant(c, variant, platform)
	}
	var entry *catalog.Entry
	if curated && !isBase {
		entry = findCatalogEntry(c, variant, flavor, plat)
	}
	last := raw
	if i := strings.LastIndex(raw, "/"); i >= 0 {
		last = raw[i+1:]
	}
	if last == "" {
		last = "image"
	}
	req := &Request{
		SchemaVersion: 1,
		Kind:          "build-request",
		CustomImage:   true,
		Image:         installImage,
		Registry:      registry,
		Options: Options{
			Label:          label,
			Packages:       nonNil(f.Packages),
			Flatpaks:       nonNil(f.Flatpaks),
			ExtraRun:       nonNil(f.ExtraRun),
			OutputFilename: c.Config.Output.FilenamePrefix + "-" + strings.NewReplacer(":", "-", "/", "-").Replace(last) + ".iso",
		},
		CatalogVersion: c.Snapshot.SnapshotDigest,
	}
	if entry != nil {
		req.CustomImage = false
		t := &Target{
			Variant:       entry.Target.Variant,
			Flavor:        entry.Target.Flavor,
			Platform:      entry.Target.Platform,
			CPUBaseline:   entry.Target.CPUBaseline,
			HardwareScope: entry.Target.HardwareScope,
		}
		if t.CPUBaseline == "" {
			t.CPUBaseline = cpuBaselineForTarget(t.Variant, t.Platform)
		}
		if t.HardwareScope == "" {
			t.HardwareScope = hardwareScopeForFlavor(t.Flavor)
		}
		req.Target = t
		ri := func(k string) string { v, _ := entry.ResolvedInputs[k].(string); return v }
		req.ResolvedInputs = &ResolvedInputs{
			PlatformManifestDigest: ri("platformManifestDigest"),
			IndexDigest:            ri("indexDigest"),
			ConfigDigest:           ri("configDigest"),
			LiveOverlayDigest:      ri("liveOverlayDigest"),
			LiveOverlayBaseDigest:  ri("liveOverlayBaseDigest"),
			InstallerRevision:      ri("installerRevision"),
			EngineRevision:         ri("engineRevision"),
		}
		// strictObservedGrant is a Playwright-only seam: never present here.
		if q := catalog.Qualification(entry); q.Status == "qualified" && q.ReceiptDigest != "" {
			req.QualificationID = q.ReceiptDigest
		}
		req.Options.OutputFilename = fmt.Sprintf("%s-%s-%s-%s.iso", c.Config.Output.FilenamePrefix, t.Variant, t.Flavor, platformSlug(t.Platform))
	}
	return req
}

// FlatpakChoice resolves the build --flatpaks value: "default" (builder-config
// default_flatpaks for the desktop), "none", or a comma-separated ID list.
func FlatpakChoice(c *catalog.Catalog, desktop, choice string) ([]string, error) {
	switch choice {
	case "", "default":
		return c.DefaultFlatpaks(desktop), nil
	case "none":
		return []string{}, nil
	}
	out := []string{}
	seen := map[string]bool{}
	for _, id := range strings.Split(choice, ",") {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		if !catalog.ValidFlatpakID(id) {
			return nil, fmt.Errorf("invalid Flatpak ID %q", id)
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// FromTarget builds the request the guided picker produces for a catalog
// target: image = the leaf's publication ref, platform = the target's,
// label = builder-config volume_label, flatpaks as given.
func FromTarget(c *catalog.Catalog, targetID string, flatpaks []string) (*Request, catalog.Target, error) {
	t, ok := c.Lookup(targetID)
	if !ok {
		return nil, catalog.Target{}, fmt.Errorf("%q is not an available image in the catalog", targetID)
	}
	req := FromForm(c, Form{Image: t.Image, Platform: t.Platform, Flatpaks: flatpaks})
	if req.CustomImage || req.Target == nil {
		return nil, t, fmt.Errorf("catalog target %q did not resolve to its snapshot entry", targetID)
	}
	return req, t, nil
}

// Native returns the request JSON the helper hands to the engine. It differs
// from the browser's in exactly one field: a registry of the browser's CORS
// relay (which fronts ghcr.io only) becomes ghcr.io itself, because a native
// process needs no CORS and should not spend the relay's bandwidth. Every
// digest pin is unchanged, so the engine verifies the same bytes.
func Native(doc []byte) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(doc, &m); err != nil {
		return nil, err
	}
	if r, _ := m["registry"].(string); r == "" || strings.TrimRight(r, "/") == DefaultRelay {
		m["registry"] = DirectRegistry
	}
	return json.MarshalIndent(m, "", "  ")
}

// LoadFile reads a build-request.json exported by iso.tunaos.org and checks
// the shape the engine requires before spending any disk or network.
func LoadFile(path string) ([]byte, *Request, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, nil, fmt.Errorf("not a build request: %w", err)
	}
	if r.SchemaVersion != 0 && r.SchemaVersion != 1 {
		return nil, nil, fmt.Errorf("unsupported build request schemaVersion %d", r.SchemaVersion)
	}
	if r.Kind != "" && r.Kind != "build-request" {
		return nil, nil, fmt.Errorf("not a build request (kind %q)", r.Kind)
	}
	if strings.TrimSpace(r.Image) == "" {
		return nil, nil, fmt.Errorf("build request has no image")
	}
	return b, &r, nil
}

// SetFlatpaks replaces options.flatpaks in a request document.
func SetFlatpaks(doc []byte, ids []string) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(doc, &m); err != nil {
		return nil, err
	}
	opts, _ := m["options"].(map[string]any)
	if opts == nil {
		opts = map[string]any{}
		m["options"] = opts
	}
	opts["flatpaks"] = ids
	return json.Marshal(m)
}
