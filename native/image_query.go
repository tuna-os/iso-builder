package main

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
)

// filterCatalog supports ordinary words plus base:, de:, and arch: filters.
// An OCI/docker-style reference is treated as a one-item custom catalog so a
// user can paste an image without first adding it to the curated list.
func filterCatalog(images []curatedImage, raw string) ([]curatedImage, error) {
	query := strings.TrimSpace(raw)
	if query == "" {
		return append([]curatedImage(nil), images...), nil
	}
	if image, ok, err := parseCustomImageURI(query); ok || err != nil {
		if err != nil {
			return nil, err
		}
		return []curatedImage{image}, nil
	}

	var terms []string
	var base, desktop, arch string
	for _, token := range strings.Fields(strings.ToLower(query)) {
		switch {
		case strings.HasPrefix(token, "base:"):
			base = strings.TrimPrefix(token, "base:")
		case strings.HasPrefix(token, "de:"):
			desktop = strings.TrimPrefix(token, "de:")
		case strings.HasPrefix(token, "arch:"):
			arch = strings.TrimPrefix(token, "arch:")
		default:
			terms = append(terms, token)
		}
	}

	result := make([]curatedImage, 0, len(images))
	for _, image := range images {
		if base != "" && !strings.EqualFold(image.Base, base) {
			continue
		}
		if desktop != "" && !strings.EqualFold(image.Desktop, desktop) {
			continue
		}
		if arch != "" && !hasArchitecture(image, arch) {
			continue
		}
		text := strings.ToLower(strings.Join([]string{image.Name, image.Image, image.Org, image.Description, image.Base, image.Desktop}, " "))
		matched := true
		for _, term := range terms {
			if !strings.Contains(text, term) {
				matched = false
				break
			}
		}
		if matched {
			result = append(result, image)
		}
	}
	return result, nil
}

func hasArchitecture(image curatedImage, wanted string) bool {
	for _, arch := range image.Architectures {
		if strings.EqualFold(arch, wanted) || (wanted == "x86_64" && strings.EqualFold(arch, "amd64")) || (wanted == "aarch64" && strings.EqualFold(arch, "arm64")) {
			return true
		}
	}
	return false
}

func parseCustomImageURI(raw string) (curatedImage, bool, error) {
	lower := strings.ToLower(raw)
	known := ""
	switch {
	case strings.HasPrefix(lower, "oci://"):
		known = raw[len("oci://"):]
	case strings.HasPrefix(lower, "docker://"):
		known = raw[len("docker://"):]
	case strings.HasPrefix(lower, "ghcr://"):
		known = "ghcr.io/" + raw[len("ghcr://"):]
	default:
		return curatedImage{}, false, nil
	}
	if known == "" || strings.IndexFunc(known, unicode.IsSpace) >= 0 || strings.ContainsAny(known, "\\\"'") {
		return curatedImage{}, true, fmt.Errorf("invalid image URI %q", raw)
	}
	parsed, err := url.Parse("oci://" + known)
	if err != nil || parsed.Host == "" || !strings.Contains(parsed.Path, "/") || (!strings.Contains(parsed.Path, ":") && !strings.Contains(parsed.Path, "@")) {
		return curatedImage{}, true, fmt.Errorf("image URI must include a registry, repository, and tag or digest")
	}
	image := strings.TrimPrefix(parsed.Host+parsed.Path, "/")
	return curatedImage{
		Name:          "Custom image — " + image,
		Image:         image,
		Org:           "Custom URI",
		Description:   "User-supplied OCI image; live overlay customization is best effort.",
		Base:          "custom",
		Desktop:       "unknown",
		Architectures: []string{"amd64", "arm64"},
	}, true, nil
}
