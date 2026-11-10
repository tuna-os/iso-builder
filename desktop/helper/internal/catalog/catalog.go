// Package catalog loads the three website catalog documents
// (catalog-snapshot.json, builder-config.json, guided-catalog.json) from
// iso.tunaos.org or the copies embedded at build time, and derives the
// protocol's `catalog` event the way app/public's guided picker does.
package catalog

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Refresh the embedded fallback copies from app/public, then regenerate the
// BuildRequest parity fixtures from app.js against those exact copies (order
// matters: the fixtures must be computed from the documents embedded here).
//go:generate go run ./gen ../../../../app/public embedded
//go:generate node ../buildreq/testdata/gen-fixtures.cjs

//go:embed embedded/catalog-snapshot.json embedded/builder-config.json embedded/guided-catalog.json
var embedded embed.FS

// DefaultBaseURL is where the website serves the catalog documents.
const DefaultBaseURL = "https://iso.tunaos.org"

// Files are the documents fetched from the base URL, in this order.
var Files = []string{"catalog-snapshot.json", "builder-config.json", "guided-catalog.json"}

// SupportedPlatforms are the platforms the pinned engine accepts
// (tacklebox purefs.ParsePlatform). Others are not offered.
var SupportedPlatforms = map[string]bool{"linux/amd64": true, "linux/amd64/v2": true, "linux/arm64": true}

// Snapshot is CatalogSnapshot v1 (only the fields the helper reads).
type Snapshot struct {
	SchemaVersion  int     `json:"schemaVersion"`
	Kind           string  `json:"kind"`
	SnapshotDigest string  `json:"snapshotDigest"`
	Targets        []Entry `json:"targets"`
}

// Entry is one CatalogSnapshot target.
type Entry struct {
	TargetKey    string `json:"targetKey"`
	Availability struct {
		Available bool `json:"available"`
	} `json:"availability"`
	Facts struct {
		CompressedSize int64 `json:"compressedSize"`
	} `json:"facts"`
	Publication struct {
		Ref string `json:"ref"`
	} `json:"publication"`
	Target struct {
		Variant       string `json:"variant"`
		Flavor        string `json:"flavor"`
		Platform      string `json:"platform"`
		CPUBaseline   string `json:"cpuBaseline"`
		HardwareScope string `json:"hardwareScope"`
	} `json:"target"`
	ResolvedInputs map[string]any `json:"resolvedInputs"`
	Qualification  map[string]any `json:"qualification"`
}

// BuilderConfig is builder configuration v2 (only the fields the helper reads).
type BuilderConfig struct {
	SchemaVersion int `json:"schema_version"`
	Desktops      []struct {
		ID              string   `json:"id"`
		DefaultFlatpaks []string `json:"default_flatpaks"`
	} `json:"desktops"`
	Output struct {
		FilenamePrefix string `json:"filename_prefix"`
		VolumeLabel    string `json:"volume_label"`
	} `json:"output"`
	DefaultSelection struct {
		Kind   string `json:"kind"`
		LeafID string `json:"leaf_id"`
	} `json:"default_selection"`
	Selection struct {
		Facets []struct {
			ID     string `json:"id"`
			Label  string `json:"label"`
			Values []struct {
				ID          string `json:"id"`
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"values"`
		} `json:"facets"`
	} `json:"selection"`
}

// Guided is GuidedCatalog v1 (only the fields the helper reads).
type Guided struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Kind           string `json:"kind"`
	SnapshotDigest string `json:"snapshotDigest"`
	Leaves         []struct {
		ID     string `json:"id"`
		Source struct {
			Kind      string `json:"kind"`
			TargetKey string `json:"targetKey"`
		} `json:"source"`
		Facets map[string][]string `json:"facets"`
	} `json:"leaves"`
}

// Desktop, Base and Target are the protocol `catalog` event entries.
type Desktop struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type Base struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Target struct {
	ID               string `json:"id"`
	Base             string `json:"base"`
	Desktop          string `json:"desktop"`
	Platform         string `json:"platform"`
	Edition          string `json:"edition"`
	Hardware         string `json:"hardware"`
	Image            string `json:"image"`
	CompressedSize   int64  `json:"compressedSize"`
	BrowserQualified bool   `json:"browserQualified"`
}

// Event is the protocol `catalog` event.
type Event struct {
	Event          string    `json:"event"`
	SnapshotDigest string    `json:"snapshotDigest"`
	DefaultTarget  string    `json:"defaultTarget"`
	Desktops       []Desktop `json:"desktops"`
	Bases          []Base    `json:"bases"`
	Targets        []Target  `json:"targets"`
}

// Catalog is the parsed, cross-checked document set.
type Catalog struct {
	Snapshot Snapshot
	Config   BuilderConfig
	Guided   Guided
	// Embedded reports the documents came from the build-time copies.
	Embedded bool
	entries  map[string]*Entry
}

// Parse decodes and cross-checks the three documents.
func Parse(snapshot, config, guided []byte) (*Catalog, error) {
	c := &Catalog{}
	if err := json.Unmarshal(snapshot, &c.Snapshot); err != nil {
		return nil, fmt.Errorf("catalog-snapshot.json: %w", err)
	}
	if err := json.Unmarshal(config, &c.Config); err != nil {
		return nil, fmt.Errorf("builder-config.json: %w", err)
	}
	if err := json.Unmarshal(guided, &c.Guided); err != nil {
		return nil, fmt.Errorf("guided-catalog.json: %w", err)
	}
	if c.Snapshot.SchemaVersion != 1 || c.Snapshot.Kind != "catalog-snapshot" || !digestRE.MatchString(c.Snapshot.SnapshotDigest) {
		return nil, fmt.Errorf("catalog-snapshot.json: unsupported document")
	}
	if c.Config.SchemaVersion != 2 {
		return nil, fmt.Errorf("builder-config.json: unsupported schema_version %d", c.Config.SchemaVersion)
	}
	if c.Guided.SchemaVersion != 1 || c.Guided.Kind != "guided-image-catalog" {
		return nil, fmt.Errorf("guided-catalog.json: unsupported document")
	}
	if c.Guided.SnapshotDigest != c.Snapshot.SnapshotDigest {
		return nil, fmt.Errorf("guided-catalog.json does not bind catalog-snapshot.json (%s != %s)", c.Guided.SnapshotDigest, c.Snapshot.SnapshotDigest)
	}
	c.entries = make(map[string]*Entry, len(c.Snapshot.Targets))
	for i := range c.Snapshot.Targets {
		e := &c.Snapshot.Targets[i]
		if _, dup := c.entries[e.TargetKey]; dup {
			return nil, fmt.Errorf("catalog-snapshot.json: duplicate targetKey %s", e.TargetKey)
		}
		c.entries[e.TargetKey] = e
	}
	return c, nil
}

// Embedded returns the catalog compiled into the helper.
func EmbeddedCatalog() (*Catalog, error) {
	var docs [3][]byte
	for i, name := range Files {
		b, err := embedded.ReadFile("embedded/" + name)
		if err != nil {
			return nil, err
		}
		docs[i] = b
	}
	c, err := Parse(docs[0], docs[1], docs[2])
	if err != nil {
		return nil, fmt.Errorf("embedded catalog: %w", err)
	}
	c.Embedded = true
	return c, nil
}

// maxDocument bounds each fetched document.
const maxDocument = 64 << 20

// Fetch downloads the three documents from baseURL.
func Fetch(ctx context.Context, client *http.Client, baseURL string) (*Catalog, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	var docs [3][]byte
	for i, name := range Files {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/"+name, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxDocument+1))
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("%s: HTTP %d", name, resp.StatusCode)
		}
		if len(b) > maxDocument {
			return nil, fmt.Errorf("%s: larger than %d bytes", name, maxDocument)
		}
		docs[i] = b
	}
	return Parse(docs[0], docs[1], docs[2])
}

// Load fetches from baseURL and falls back to the embedded copy. warn
// receives the reason when the fallback is used.
func Load(ctx context.Context, baseURL string, warn func(format string, args ...any)) (*Catalog, error) {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c, err := Fetch(fctx, &http.Client{}, baseURL)
	if err == nil {
		return c, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	c, eerr := EmbeddedCatalog()
	if eerr != nil {
		return nil, eerr
	}
	warn("Could not download the latest image list from %s (%v); using the list built into this app.", baseURL, err)
	return c, nil
}

// Entry returns the snapshot entry for a targetKey.
func (c *Catalog) Entry(key string) (*Entry, bool) {
	e, ok := c.entries[key]
	return e, ok
}

// DefaultFlatpaks is builder-config's default_flatpaks for desktop, filtered
// and de-duplicated like TboxFlatpakDefaults.suggestions with no inspection.
func (c *Catalog) DefaultFlatpaks(desktop string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, d := range c.Config.Desktops {
		if d.ID != desktop {
			continue
		}
		for _, id := range d.DefaultFlatpaks {
			if ValidFlatpakID(id) && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

var appIDRE = regexp.MustCompile(`^(?:[A-Za-z_][A-Za-z0-9_]*\.){2,}[A-Za-z_-][A-Za-z0-9_-]*$`)

// ValidFlatpakID mirrors builder-config.js validFlatpakId.
func ValidFlatpakID(id string) bool { return len(id) <= 255 && appIDRE.MatchString(id) }

func (c *Catalog) facet(id string) (order map[string]int, labels map[string]Desktop) {
	order, labels = map[string]int{}, map[string]Desktop{}
	for _, f := range c.Config.Selection.Facets {
		if f.ID != id {
			continue
		}
		for i, v := range f.Values {
			order[v.ID] = i
			labels[v.ID] = Desktop{ID: v.ID, Label: v.Label, Description: v.Description}
		}
	}
	return order, labels
}

// Model derives the protocol `catalog` event: selectable (available) target
// leaves whose desktop is a configured desktop facet value and whose platform
// the engine supports; desktops and bases in builder-config facet order.
func (c *Catalog) Model() Event {
	facets := map[string]map[string]int{}
	var desktopLabels, baseLabels map[string]Desktop
	for _, id := range []string{"desktop", "base", "edition", "hardware", "platform"} {
		order, labels := c.facet(id)
		facets[id] = order
		switch id {
		case "desktop":
			desktopLabels = labels
		case "base":
			baseLabels = labels
		}
	}
	rank := func(facet, v string) int {
		if i, ok := facets[facet][v]; ok {
			return i
		}
		return len(facets[facet])
	}
	first := func(m map[string][]string, k string) string {
		if v := m[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	ev := Event{Event: "catalog", SnapshotDigest: c.Snapshot.SnapshotDigest, Desktops: []Desktop{}, Bases: []Base{}, Targets: []Target{}}
	for _, leaf := range c.Guided.Leaves {
		if leaf.Source.Kind != "target" || leaf.ID != leaf.Source.TargetKey {
			continue
		}
		e, ok := c.entries[leaf.Source.TargetKey]
		if !ok || !e.Availability.Available || !SupportedPlatforms[e.Target.Platform] {
			continue
		}
		desktop := first(leaf.Facets, "desktop")
		if _, ok := facets["desktop"][desktop]; !ok {
			continue // base images ("none") and unconfigured desktops
		}
		ev.Targets = append(ev.Targets, Target{
			ID:               leaf.ID,
			Base:             e.Target.Variant,
			Desktop:          desktop,
			Platform:         e.Target.Platform,
			Edition:          first(leaf.Facets, "edition"),
			Hardware:         first(leaf.Facets, "hardware"),
			Image:            e.Publication.Ref,
			CompressedSize:   e.Facts.CompressedSize,
			BrowserQualified: Qualification(e).Status == "qualified",
		})
	}
	sort.SliceStable(ev.Targets, func(i, j int) bool {
		a, b := ev.Targets[i], ev.Targets[j]
		for _, k := range [][3]string{{"desktop", a.Desktop, b.Desktop}, {"base", a.Base, b.Base}, {"edition", a.Edition, b.Edition}, {"hardware", a.Hardware, b.Hardware}, {"platform", a.Platform, b.Platform}} {
			if ra, rb := rank(k[0], k[1]), rank(k[0], k[2]); ra != rb {
				return ra < rb
			}
		}
		return a.ID < b.ID
	})
	seenD, seenB := map[string]bool{}, map[string]bool{}
	for _, t := range ev.Targets {
		seenD[t.Desktop], seenB[t.Base] = true, true
	}
	for _, f := range c.Config.Selection.Facets {
		for _, v := range f.Values {
			switch {
			case f.ID == "desktop" && seenD[v.ID]:
				ev.Desktops = append(ev.Desktops, desktopLabels[v.ID])
			case f.ID == "base" && seenB[v.ID]:
				ev.Bases = append(ev.Bases, Base{ID: v.ID, Label: baseLabels[v.ID].Label})
			}
		}
	}
	for _, t := range ev.Targets {
		if c.Config.DefaultSelection.Kind == "leaf" && t.ID == c.Config.DefaultSelection.LeafID {
			ev.DefaultTarget = t.ID
		}
	}
	if ev.DefaultTarget == "" && len(ev.Targets) > 0 {
		ev.DefaultTarget = ev.Targets[0].ID
	}
	return ev
}

// Lookup returns the selectable model target with id.
func (c *Catalog) Lookup(id string) (Target, bool) {
	for _, t := range c.Model().Targets {
		if t.ID == id {
			return t, true
		}
	}
	return Target{}, false
}
