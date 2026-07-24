package main

import (
	"image/color"
	"os"
	"path/filepath"
	"sync"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
)

// adwaitaTheme skins the app to approximate GNOME's libadwaita: the Adwaita
// accent blue (#3584e4) and libadwaita's window/view/button greys in both
// light and dark, and — where they're installed — GNOME's own UI fonts
// (Adwaita Sans / Cantarell) and monospace (Adwaita Mono), so text matches
// the rest of the desktop instead of Fyne's bundled font. Icons and most
// sizes fall through to the default theme.
//
// It also fixes the log's readability: the log is a disabled Entry, and
// Fyne's default "disabled" colour is so close to the dark background it
// reads as grey-on-grey (tuna-os/iso-builder). ColorNameDisabled here is a
// genuinely legible dim, matching how Adwaita dims insensitive text.
type adwaitaTheme struct{}

var _ fyne.Theme = adwaitaTheme{}

// System UI/monospace font candidates, most-preferred first, covering
// Fedora/Bluefin, Debian/Ubuntu and Arch layouts. Absent files are skipped,
// so this is a no-op (→ default Fyne font) on machines without them, incl.
// macOS/Windows.
var (
	sansRegularFonts = []string{
		"/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf",
		"/usr/share/fonts/adwaita-sans-fonts/AdwaitaSans-Regular.ttf",
		"/usr/share/fonts/abattis-cantarell/Cantarell-Regular.otf",
		"/usr/share/fonts/cantarell/Cantarell-Regular.otf",
		"/usr/share/fonts/abattis-cantarell/Cantarell-VF.otf",
		"/usr/share/fonts/cantarell/Cantarell-VF.otf",
	}
	sansItalicFonts = []string{
		"/usr/share/fonts/Adwaita/AdwaitaSans-Italic.ttf",
		"/usr/share/fonts/adwaita-sans-fonts/AdwaitaSans-Italic.ttf",
	}
	monoRegularFonts = []string{
		"/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf",
		"/usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf",
		"/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
		"/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
	}
	monoBoldFonts   = []string{"/usr/share/fonts/Adwaita/AdwaitaMono-Bold.ttf"}
	monoItalicFonts = []string{"/usr/share/fonts/Adwaita/AdwaitaMono-Italic.ttf"}
)

var (
	fontCacheMu sync.Mutex
	fontCache   = map[string]fyne.Resource{} // path → resource ("" ⇒ known-missing)
)

func loadFirstFont(paths []string) fyne.Resource {
	fontCacheMu.Lock()
	defer fontCacheMu.Unlock()
	for _, p := range paths {
		if r, seen := fontCache[p]; seen {
			if r != nil {
				return r
			}
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			fontCache[p] = nil // remember the miss
			continue
		}
		r := fyne.NewStaticResource(filepath.Base(p), b)
		fontCache[p] = r
		return r
	}
	return nil
}

func (adwaitaTheme) Font(s fyne.TextStyle) fyne.Resource {
	var r fyne.Resource
	switch {
	case s.Monospace && s.Bold:
		r = loadFirstFont(monoBoldFonts)
	case s.Monospace && s.Italic:
		r = loadFirstFont(monoItalicFonts)
	case s.Monospace:
		r = loadFirstFont(monoRegularFonts)
	case s.Bold:
		// No static Adwaita Sans Bold ships; keep the default bold so headers
		// stay emphasised rather than silently rendering regular-weight.
	case s.Italic:
		r = loadFirstFont(sansItalicFonts)
	default:
		r = loadFirstFont(sansRegularFonts)
	}
	if r != nil {
		return r
	}
	return theme.DefaultTheme().Font(s)
}

func (adwaitaTheme) Icon(n fyne.ThemeIconName) fyne.Resource { return theme.DefaultTheme().Icon(n) }

func (adwaitaTheme) Size(n fyne.ThemeSizeName) float32 {
	// Adwaita breathes a little more than Fyne's default 4px padding.
	if n == theme.SizeNamePadding {
		return 6
	}
	return theme.DefaultTheme().Size(n)
}

func (adwaitaTheme) Color(name fyne.ThemeColorName, v fyne.ThemeVariant) color.Color {
	dark := v == theme.VariantDark
	pick := func(d, l color.Color) color.Color {
		if dark {
			return d
		}
		return l
	}
	switch name {
	case theme.ColorNamePrimary, theme.ColorNameFocus:
		return color.NRGBA{0x35, 0x84, 0xe4, 0xff} // Adwaita accent blue
	case theme.ColorNameSelection:
		return color.NRGBA{0x35, 0x84, 0xe4, 0x66}
	case theme.ColorNameBackground:
		return pick(color.NRGBA{0x24, 0x24, 0x24, 0xff}, color.NRGBA{0xfa, 0xfa, 0xfb, 0xff})
	case theme.ColorNameInputBackground, theme.ColorNameOverlayBackground, theme.ColorNameMenuBackground:
		return pick(color.NRGBA{0x1e, 0x1e, 0x1e, 0xff}, color.NRGBA{0xff, 0xff, 0xff, 0xff})
	case theme.ColorNameButton:
		return pick(color.NRGBA{0x3a, 0x3a, 0x3a, 0xff}, color.NRGBA{0xff, 0xff, 0xff, 0xff})
	case theme.ColorNameDisabledButton:
		return pick(color.NRGBA{0x2a, 0x2a, 0x2a, 0xff}, color.NRGBA{0xf0, 0xf0, 0xf0, 0xff})
	case theme.ColorNameForeground:
		return pick(color.NRGBA{0xff, 0xff, 0xff, 0xff}, color.NRGBA{0x2e, 0x34, 0x36, 0xff})
	case theme.ColorNameDisabled:
		// Readable dim — the log renders in this colour.
		return pick(color.NRGBA{0xc4, 0xc4, 0xc4, 0xff}, color.NRGBA{0x55, 0x55, 0x55, 0xff})
	case theme.ColorNamePlaceHolder:
		return pick(color.NRGBA{0x9a, 0x9a, 0x9a, 0xff}, color.NRGBA{0x77, 0x76, 0x7b, 0xff})
	case theme.ColorNameHover:
		return pick(color.NRGBA{0xff, 0xff, 0xff, 0x14}, color.NRGBA{0x00, 0x00, 0x00, 0x0d})
	case theme.ColorNamePressed:
		return pick(color.NRGBA{0xff, 0xff, 0xff, 0x24}, color.NRGBA{0x00, 0x00, 0x00, 0x1a})
	case theme.ColorNameSeparator, theme.ColorNameInputBorder:
		return pick(color.NRGBA{0xff, 0xff, 0xff, 0x1a}, color.NRGBA{0x00, 0x00, 0x00, 0x1a})
	case theme.ColorNameScrollBar:
		return pick(color.NRGBA{0xff, 0xff, 0xff, 0x30}, color.NRGBA{0x00, 0x00, 0x00, 0x30})
	}
	return theme.DefaultTheme().Color(name, v)
}
