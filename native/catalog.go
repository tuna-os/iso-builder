package main

import (
	"bytes"
	"embed"
	"fmt"
	"image"
	_ "image/png"

	"fyne.io/fyne/v2"
)

//go:embed assets/*.png
var catalogAssetsFS embed.FS

// curatedImage is one entry in the hand-picked image list — the guided
// picker's alternative to typing raw recipe JSON (see
// tuna-os/iso-builder#3's Guided/Advanced split). Beyond TunaOS's own
// variant×desktop matrix, this also curates real, verified images from
// three other bootc/ublue-style projects — see buildExternalCatalog's
// doc comment for why "verified" matters here specifically.
type curatedImage struct {
	Name        string
	Image       string // <repo>:<tag>
	Org         string // display grouping — project/publisher, not TunaOS's own desktop-variant axis
	Description string
	LogoAsset   string // filename under assets/, e.g. "tuna-os.png" — "" falls back to no icon
}

// desktopName maps a desktop ID to its display name — copied from
// ../app/public/app.js's DESKTOPS map (source of truth; keep in sync by
// hand, there are only 5). Deliberately dropping app.js's emoji: this is a
// native desktop app, not a web picker skinned to match the browser one.
var desktopName = map[string]string{
	"gnome":  "GNOME",
	"kde":    "KDE Plasma",
	"cosmic": "COSMIC",
	"niri":   "Niri",
	"xfce":   "XFCE",
}

// variant is one base OS in the image matrix, copied from
// ../app/public/app.js's VARIANTS array — real tuna-os image IDs
// (fish-themed codenames, not a coincidence). Community desktops
// (kde/cosmic/niri/xfce) aren't published as ISOs there either, so this
// app is one of the only ways to get them, same as the browser picker.
type variant struct {
	id       string
	name     string
	desktops []string
}

var variants = []variant{
	{"yellowfin", "AlmaLinux Kitten 10 (flagship)", []string{"gnome", "kde", "cosmic", "niri"}},
	{"bonito", "Fedora 44", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"sailfin", "openSUSE Tumbleweed", []string{"gnome", "kde", "niri", "xfce"}},
	{"flounder", "Debian 13 Trixie", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"grouper", "Ubuntu 26.04", []string{"gnome", "kde", "niri", "xfce"}},
	{"marlin", "Arch Linux", []string{"gnome", "kde", "cosmic", "niri", "xfce"}},
	{"skipjack", "CentOS Stream 10", []string{"gnome", "kde", "cosmic", "niri"}},
	{"albacore", "AlmaLinux 10", []string{"gnome", "kde", "cosmic", "niri"}},
	{"guppy", "Gentoo (source-based)", []string{"gnome", "kde"}},
}

// curatedImages is the full picker list: TunaOS's own variant×desktop
// matrix plus a curated set of real external projects. Generated from
// variants/desktopName and buildExternalCatalog rather than one giant
// hand-typed literal — the fabricated-image-list bug this replaced
// happened specifically because a hand-typed list wasn't checked against
// a source of truth until after the fact. Generating the TunaOS half from
// the same structured data app.js itself iterates over, and sourcing the
// external half from actually-queried GHCR package listings (see that
// function's doc comment), makes that class of bug structurally harder
// to reintroduce on either half.
var curatedImages = append(buildCuratedImages(), buildExternalCatalog()...)

func buildCuratedImages() []curatedImage {
	var out []curatedImage
	for _, v := range variants {
		for _, de := range v.desktops {
			name := desktopName[de]
			if name == "" {
				name = de
			}
			out = append(out, curatedImage{
				Name:        v.name + " — " + name,
				Image:       fmt.Sprintf("ghcr.io/tuna-os/%s:%s", v.id, de),
				Org:         "TunaOS",
				Description: "Part of the TunaOS project's own curated fish-themed image set.",
				LogoAsset:   "tuna-os.png",
			})
		}
	}
	return out
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
			Name:        "Bluefin (GNOME)",
			Image:       "ghcr.io/projectbluefin/bluefin:stable",
			Org:         "Project Bluefin",
			Description: "The next-generation Linux workstation, from the project's own dedicated org (projectbluefin.io).",
			LogoAsset:   "projectbluefin.png",
		},
		{
			Name:        "Bluefin DX (GNOME, developer-focused)",
			Image:       "ghcr.io/ublue-os/bluefin-dx:latest",
			Org:         "Universal Blue",
			Description: "Bluefin's developer-focused variant — container toolboxes, dev tooling preinstalled.",
			LogoAsset:   "ublue-os.png",
		},
		{
			Name:        "Aurora (KDE Plasma)",
			Image:       "ghcr.io/ublue-os/aurora:latest",
			Org:         "Universal Blue",
			Description: "Universal Blue's KDE Plasma desktop image — Bluefin's KDE sibling.",
			LogoAsset:   "ublue-os.png",
		},
		{
			Name:        "Aurora DX (KDE Plasma, developer-focused)",
			Image:       "ghcr.io/ublue-os/aurora-dx:latest",
			Org:         "Universal Blue",
			Description: "Aurora's developer-focused variant — container toolboxes, dev tooling preinstalled.",
			LogoAsset:   "ublue-os.png",
		},
		{
			Name:        "Bazzite (gaming-focused)",
			Image:       "ghcr.io/ublue-os/bazzite:latest",
			Org:         "Universal Blue",
			Description: "Universal Blue's gaming-focused image — SteamOS-like, built for handhelds and living-room PCs.",
			LogoAsset:   "ublue-os.png",
		},
		{
			Name:        "Zirconium (Niri)",
			Image:       "ghcr.io/zirconium-dev/zirconium:latest",
			Org:         "Zirconium",
			Description: "An opinionated Niri (scrollable-tiling Wayland compositor) bootc image.",
			LogoAsset:   "zirconium-dev.png",
		},
		{
			Name:        "Zirconium Hawaii (Niri, Freedesktop-SDK based)",
			Image:       "ghcr.io/zirconium-dev/zirconium-hawaii:latest",
			Org:         "Zirconium",
			Description: "Zirconium's Niri image built on top of Freedesktop-SDK instead of a traditional distro base.",
			LogoAsset:   "zirconium-dev.png",
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
