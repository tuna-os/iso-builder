package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"slices"

	"fyne.io/fyne/v2"
)

//go:embed assets/*.png catalog-snapshot.json
var catalogAssetsFS embed.FS

// curatedImage is one entry in the hand-picked image list — the guided
// picker's alternative to typing raw recipe JSON (see
// tuna-os/iso-builder#3's Guided/Advanced split). Beyond TunaOS's own
// variant×desktop matrix, this also curates real, verified images from
// three other bootc/ublue-style projects — see buildExternalCatalog's
// doc comment for why "verified" matters here specifically.
type curatedImage struct {
	Name                string
	Image               string // <repo>:<tag>
	Org                 string // display grouping — project/publisher, not TunaOS's own desktop-variant axis
	Description         string
	LogoAsset           string   // filename under assets/, e.g. "tuna-os.png" — "" falls back to no icon
	Base                string   // searchable base/variant identifier
	Desktop             string   // searchable desktop identifier (gnome, kde, ...)
	Architectures       []string // architectures advertised by the image
	Platforms           []string // canonical OCI platforms from CatalogSnapshot v1
	QualificationStatus string   // qualified | local-only | unqualified | unsupported
	External            bool     // true for third-party/external references
}

// desktopName maps a desktop ID to its display name — shared with
// ../app/public/app.js's DESKTOPS map.
var desktopName = map[string]string{
	"gnome":  "GNOME",
	"kde":    "KDE Plasma",
	"cosmic": "COSMIC",
	"niri":   "Niri",
	"xfce":   "XFCE",
}

var desktopOrder = []string{"gnome", "kde", "cosmic", "niri", "xfce"}

type variantMeta struct {
	id   string
	name string
}

var pickerVariantOrder = []variantMeta{
	{id: "yellowfin", name: "AlmaLinux Kitten 10 (flagship)"},
	{id: "bonito", name: "Fedora 44"},
	{id: "sailfin", name: "openSUSE Tumbleweed"},
	{id: "flounder", name: "Debian 13 Trixie"},
	{id: "grouper", name: "Ubuntu 26.04"},
	{id: "marlin", name: "Arch Linux"},
	{id: "skipjack", name: "CentOS Stream 10"},
	{id: "albacore", name: "AlmaLinux 10"},
	{id: "guppy", name: "Gentoo (source-based)"},
}

// variant is one base OS in the image matrix, derived from the shared
// CatalogSnapshot v1 (catalog-snapshot.json) that both app/public/app.js
// and native/catalog.go consume.
type variant struct {
	id       string
	name     string
	desktops []string
}

type catalogSnapshotDoc struct {
	SchemaVersion  int                  `json:"schemaVersion"`
	Kind           string               `json:"kind"`
	CoverageDigest string               `json:"coverageDigest"`
	SnapshotDigest string               `json:"snapshotDigest"`
	Targets        []catalogTargetEntry `json:"targets"`
}

type catalogTargetEntry struct {
	TargetKey string `json:"targetKey"`
	Required  bool   `json:"required"`
	Scheduled bool   `json:"scheduled"`
	Target    struct {
		Variant       string `json:"variant"`
		Flavor        string `json:"flavor"`
		Platform      string `json:"platform"`
		CPUBaseline   string `json:"cpuBaseline"`
		HardwareScope string `json:"hardwareScope"`
	} `json:"target"`
	Publication struct {
		Repository string `json:"repository"`
		Tag        string `json:"tag"`
		Ref        string `json:"ref"`
	} `json:"publication"`
	Availability struct {
		Available   bool `json:"available"`
		OCIPlatform struct {
			OS           string  `json:"os"`
			Architecture string  `json:"architecture"`
			Variant      *string `json:"variant"`
		} `json:"ociPlatform"`
	} `json:"availability"`
	Qualification struct {
		Status string  `json:"status"`
		Reason *string `json:"reason"`
	} `json:"qualification"`
}

func loadEmbeddedCatalogSnapshot() (*catalogSnapshotDoc, error) {
	data, err := catalogAssetsFS.ReadFile("catalog-snapshot.json")
	if err != nil {
		return nil, fmt.Errorf("read embedded catalog-snapshot.json: %w", err)
	}
	var doc catalogSnapshotDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decode catalog-snapshot.json: %w", err)
	}
	if doc.SchemaVersion != 1 || doc.Kind != "catalog-snapshot" || len(doc.Targets) == 0 {
		return nil, fmt.Errorf("invalid catalog-snapshot.json header (schemaVersion=%d kind=%q targets=%d)",
			doc.SchemaVersion, doc.Kind, len(doc.Targets))
	}
	return &doc, nil
}

func loadVariantsFromSnapshot(doc *catalogSnapshotDoc) []variant {
	if doc == nil {
		return nil
	}
	offered := make(map[string]map[string]bool)
	for _, entry := range doc.Targets {
		vid := entry.Target.Variant
		fid := entry.Target.Flavor
		if _, ok := desktopName[fid]; !ok {
			continue
		}
		if !entry.Scheduled && !entry.Availability.Available {
			continue
		}
		if offered[vid] == nil {
			offered[vid] = make(map[string]bool)
		}
		offered[vid][fid] = true
	}
	var out []variant
	for _, vm := range pickerVariantOrder {
		desMap := offered[vm.id]
		if len(desMap) == 0 {
			continue
		}
		var des []string
		for _, de := range desktopOrder {
			if desMap[de] {
				des = append(des, de)
			}
		}
		if len(des) > 0 {
			out = append(out, variant{id: vm.id, name: vm.name, desktops: des})
		}
	}
	return out
}

var embeddedSnapshot, _ = loadEmbeddedCatalogSnapshot()
var variants = loadVariantsFromSnapshot(embeddedSnapshot)

var curatedImages = append(buildCuratedImages(), buildExternalCatalog()...)

func buildCuratedImages() []curatedImage {
	var out []curatedImage
	for _, v := range variants {
		for _, de := range v.desktops {
			name := desktopName[de]
			if name == "" {
				name = de
			}
			arches, plats, qualStatus := snapshotTargetMetadata(embeddedSnapshot, v.id, de)
			out = append(out, curatedImage{
				Name:                v.name + " — " + name,
				Image:               fmt.Sprintf("ghcr.io/tuna-os/%s:%s", v.id, de),
				Org:                 "TunaOS",
				Description:         "Part of the TunaOS project's own curated fish-themed image set.",
				LogoAsset:           "tuna-os.png",
				Base:                v.id,
				Desktop:             de,
				Architectures:       arches,
				Platforms:           plats,
				QualificationStatus: qualStatus,
				External:            false,
			})
		}
	}
	return out
}

func snapshotTargetMetadata(doc *catalogSnapshotDoc, variantID, desktopID string) (arches, platforms []string, qualStatus string) {
	qualStatus = "unqualified"
	if doc != nil {
		for _, entry := range doc.Targets {
			if entry.Target.Variant != variantID || entry.Target.Flavor != desktopID {
				continue
			}
			if !entry.Scheduled && !entry.Availability.Available {
				continue
			}
			plat := entry.Target.Platform
			if plat != "" && !slices.Contains(platforms, plat) {
				platforms = append(platforms, plat)
			}
			arch := entry.Availability.OCIPlatform.Architecture
			if arch != "" && !slices.Contains(arches, arch) {
				arches = append(arches, arch)
			}
			if entry.Qualification.Status == "qualified" {
				qualStatus = "qualified"
			} else if qualStatus != "qualified" && entry.Qualification.Status != "" {
				qualStatus = entry.Qualification.Status
			}
		}
	}
	if len(arches) == 0 {
		arches = []string{"amd64", "arm64"}
	}
	return arches, platforms, qualStatus
}

// buildExternalCatalog returns a curated (not exhaustive) set of real
// bootc/ublue-style images from three other projects, at the user's
// request. Every image ref and tag here was checked live against each
// project's actual GHCR package listing before being added — this app
// already has one real incident (tuna-os/iso-builder's own early commit
// history) of a hand-typed catalog turning out to be entirely invented
// image refs that were never checked against a source of truth. Verified
// at the time of writing:
//   - ghcr.io/projectbluefin/bluefin:stable — Project Bluefin's own
//     dedicated org (projectbluefin.io), confirmed via its package
//     listing; "stable" is a real, currently-published tag there. No
//     "dx" tag exists on this org's bluefin package — the DX variant is
//     only published under ublue-os, not mirrored here yet.
//   - ghcr.io/ublue-os/{bluefin-dx,aurora,aurora-dx,bazzite}:latest —
//     confirmed present in ublue-os's package listing. Aurora and
//     Bazzite don't have their own dedicated orgs the way Bluefin does,
//     so they're curated from the broader Universal Blue community org.
//   - ghcr.io/zirconium-dev/{zirconium,zirconium-hawaii}:latest —
//     confirmed present in zirconium-dev's package listing; a Niri-based
//     bootc image family.
//
// Logos are each project's real GitHub org avatar (fetched once,
// downscaled, vendored under assets/) — used for identification the same
// way a package manager shows an app's real icon, not a redrawn/stylized
// substitute.
func buildExternalCatalog() []curatedImage {
	return []curatedImage{
		{
			Name:                "Bluefin (GNOME)",
			Image:               "ghcr.io/projectbluefin/bluefin:stable",
			Org:                 "Project Bluefin",
			Description:         "The next-generation Linux workstation, from the project's own dedicated org (projectbluefin.io).",
			LogoAsset:           "projectbluefin.png",
			Base:                "fedora",
			Desktop:             "gnome",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Bluefin DX (GNOME, developer-focused)",
			Image:               "ghcr.io/ublue-os/bluefin-dx:latest",
			Org:                 "Universal Blue",
			Description:         "Bluefin's developer-focused variant — container toolboxes, dev tooling preinstalled.",
			LogoAsset:           "ublue-os.png",
			Base:                "fedora",
			Desktop:             "gnome",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Aurora (KDE Plasma)",
			Image:               "ghcr.io/ublue-os/aurora:latest",
			Org:                 "Universal Blue",
			Description:         "Universal Blue's KDE Plasma desktop image — Bluefin's KDE sibling.",
			LogoAsset:           "ublue-os.png",
			Base:                "fedora",
			Desktop:             "kde",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Aurora DX (KDE Plasma, developer-focused)",
			Image:               "ghcr.io/ublue-os/aurora-dx:latest",
			Org:                 "Universal Blue",
			Description:         "Aurora's developer-focused variant — container toolboxes, dev tooling preinstalled.",
			LogoAsset:           "ublue-os.png",
			Base:                "fedora",
			Desktop:             "kde",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Bazzite (gaming-focused)",
			Image:               "ghcr.io/ublue-os/bazzite:latest",
			Org:                 "Universal Blue",
			Description:         "Universal Blue's gaming-focused image — SteamOS-like, built for handhelds and living-room PCs.",
			LogoAsset:           "ublue-os.png",
			Base:                "fedora",
			Desktop:             "unknown",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Zirconium (Niri)",
			Image:               "ghcr.io/zirconium-dev/zirconium:latest",
			Org:                 "Zirconium",
			Description:         "An opinionated Niri (scrollable-tiling Wayland compositor) bootc image.",
			LogoAsset:           "zirconium-dev.png",
			Base:                "freedesktop-sdk",
			Desktop:             "niri",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
		{
			Name:                "Zirconium Hawaii (Niri, Freedesktop-SDK based)",
			Image:               "ghcr.io/zirconium-dev/zirconium-hawaii:latest",
			Org:                 "Zirconium",
			Description:         "Zirconium's Niri image built on top of Freedesktop-SDK instead of a traditional distro base.",
			LogoAsset:           "zirconium-dev.png",
			Base:                "freedesktop-sdk",
			Desktop:             "niri",
			Architectures:       []string{"amd64", "arm64"},
			QualificationStatus: "unqualified",
			External:            true,
		},
	}
}

// catalogLogoCache avoids re-decoding the same embedded PNG on every list
// row redraw — Fyne's widget.List recreates/reuses row widgets
// aggressively as the user scrolls, so this gets called often for the
// same handful of logos.
var catalogLogoCache = map[string]fyne.Resource{}

// catalogLogo returns a Fyne resource for an embedded logo asset, or nil
// if assetName is empty or the asset can't be loaded — callers should
// treat nil as "render no icon for this row" rather than erroring, since
// a missing logo shouldn't block the whole catalog from being usable.
func catalogLogo(assetName string) fyne.Resource {
	if assetName == "" {
		return nil
	}
	if r, ok := catalogLogoCache[assetName]; ok {
		return r
	}
	data, err := catalogAssetsFS.ReadFile("assets/" + assetName)
	if err != nil {
		return nil
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return nil
	}
	r := fyne.NewStaticResource(assetName, data)
	catalogLogoCache[assetName] = r
	return r
}
