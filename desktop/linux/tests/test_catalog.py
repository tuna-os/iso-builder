from tunaos_media_writer.catalog import Catalog, host_platform

AMD64 = "linux/amd64"


def synthetic():
    return Catalog.from_event(
        {
            "defaultTarget": "yellowfin:gnome:linux/amd64",
            "desktops": [
                {"id": "gnome", "label": "GNOME", "description": "Clean"},
                {"id": "kde", "label": "KDE Plasma"},
                {"id": "niri", "label": "Niri"},
            ],
            "bases": [{"id": "yellowfin", "label": "AlmaLinux Kitten 10"}, {"id": "bonito", "label": "Fedora 44"}],
            "targets": [
                {"id": "yellowfin:gnome:linux/amd64", "base": "yellowfin", "desktop": "gnome", "platform": AMD64,
                 "edition": "standard", "hardware": "generic", "compressedSize": 10},
                {"id": "bonito:gnome:linux/amd64", "base": "bonito", "desktop": "gnome", "platform": AMD64},
                {"id": "bonito:kde:linux/amd64", "base": "bonito", "desktop": "kde", "platform": AMD64},
                {"id": "yellowfin:kde-nvidia:linux/amd64", "base": "yellowfin", "desktop": "kde",
                 "platform": AMD64, "edition": "nvidia"},
                {"id": "bonito:niri:linux/arm64", "base": "bonito", "desktop": "niri", "platform": "linux/arm64"},
                {"id": "bonito:niri:apple", "base": "bonito", "desktop": "niri", "platform": AMD64,
                 "hardware": "apple-t2"},
            ],
        }
    )


def test_only_standard_generic_host_targets_are_offered():
    catalog = synthetic()
    assert [d.id for d in catalog.desktops_for(AMD64)] == ["gnome", "kde"]
    assert [d.id for d in catalog.desktops_for("linux/arm64")] == ["niri"]
    assert [b.id for b in catalog.bases_for("kde", AMD64)] == ["bonito"]  # the nvidia edition is not default


def test_default_selection_follows_catalog_default_then_order():
    catalog = synthetic()
    assert catalog.default_desktop(AMD64) == "gnome"
    assert catalog.default_base_for("gnome", AMD64) == "yellowfin"
    # yellowfin has no standard KDE target, so the first base offering KDE wins.
    assert catalog.default_base_for("kde", AMD64) == "bonito"
    assert catalog.default_desktop("linux/arm64") == "niri"
    assert catalog.default_desktop("linux/riscv64") is None


def test_target_lookup():
    catalog = synthetic()
    assert catalog.target_for("yellowfin", "gnome", AMD64).compressed_size == 10
    assert catalog.target_for("yellowfin", "kde", AMD64) is None


def test_host_platform_mapping():
    assert host_platform("x86_64") == "linux/amd64"
    assert host_platform("aarch64") == "linux/arm64"
    assert host_platform("riscv64") == "linux/riscv64"


def test_fixture_catalog(catalog_event):
    catalog = Catalog.from_event(catalog_event)
    assert [d.id for d in catalog.desktops_for(AMD64)] == ["gnome", "kde", "cosmic", "niri", "xfce"]
    assert catalog.default_desktop(AMD64) == "gnome"
    assert catalog.default_base_for("gnome", AMD64) == "yellowfin"
    target = catalog.target_for("yellowfin", "gnome", AMD64)
    assert target.id == "yellowfin:gnome:linux/amd64"
    assert target.image == "ghcr.io/tuna-os/yellowfin:gnome"


def test_malformed_catalog_entries_are_dropped():
    catalog = Catalog.from_event({"desktops": [{"label": "no id"}, "x"], "targets": None})
    assert catalog.desktops == () and catalog.targets == ()
