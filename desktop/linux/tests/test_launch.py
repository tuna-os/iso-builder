import pytest

from tunaos_media_writer.launch import LinkError, cell_and_digest, target_from_uri, target_id


@pytest.mark.parametrize(
    "value",
    ["yellowfin:gnome:linux/amd64", "albacore:gnome-hwe:linux/amd64/v2", "flounder-sid:xfce:linux/arm64"],
)
def test_target_id_valid(value):
    assert target_id(value) == value


@pytest.mark.parametrize(
    "value",
    ["", "yellowfin", "yellowfin:gnome", "yellowfin:gnome:linux", "Yellowfin:gnome:linux/amd64",
     "yellowfin:gnome:linux/amd64 ", "--fake-helper", "../../etc:passwd:linux/amd64", "a:b:c/d:e"],
)
def test_target_id_invalid(value):
    with pytest.raises(LinkError):
        target_id(value)


@pytest.mark.parametrize(
    "uri",
    [
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64",
        "tunaos-media-writer://build?target=yellowfin:gnome:linux/amd64",
        "tunaos-media-writer://build/?target=yellowfin%3Agnome%3Alinux%2Famd64",
        "TUNAOS-MEDIA-WRITER://BUILD?target=yellowfin%3Agnome%3Alinux%2Famd64",
    ],
)
def test_uri_valid(uri):
    assert target_from_uri(uri) == "yellowfin:gnome:linux/amd64"


def test_uri_url_encoded_variant_path():
    uri = "tunaos-media-writer://build?target=albacore%3Agnome-hwe%3Alinux%2Famd64%2Fv2"
    assert target_from_uri(uri) == "albacore:gnome-hwe:linux/amd64/v2"


@pytest.mark.parametrize(
    "uri",
    [
        "https://iso.tunaos.org/?target=yellowfin%3Agnome%3Alinux%2Famd64",  # unknown scheme
        "file:///home/u/build-request.json",
        "tunaos-media-writer://write?target=yellowfin%3Agnome%3Alinux%2Famd64",  # unknown action
        "tunaos-media-writer://build/extra?target=yellowfin%3Agnome%3Alinux%2Famd64",
        "tunaos-media-writer://build",  # no target
        "tunaos-media-writer://build?target=",
        "tunaos-media-writer://build?target=a%3Ab%3Alinux%2Famd64&target=c%3Ad%3Alinux%2Famd64",
        "tunaos-media-writer://build?target=not-a-target",  # invalid id
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64%0A",
    ],
)
def test_uri_invalid(uri):
    with pytest.raises(LinkError):
        target_from_uri(uri)


def test_uri_without_cell_has_empty_cell_and_digest():
    uri = "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64"
    assert cell_and_digest(uri) == ("", "")


def test_uri_with_cell_and_digest():
    uri = ("tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64"
           "&cell=ghcr.io%2Ftuna-os%2Fexample-installer%3Astable"
           "&digest=sha256%3A5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735")
    cell, digest = cell_and_digest(uri)
    assert cell == "ghcr.io/tuna-os/example-installer:stable"
    assert digest == "sha256:5d1e1de95521dd31273571f66b92a8671755cb411d209c13bed4cab65db6f735"


@pytest.mark.parametrize(
    "uri",
    [
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64&cell=%20",
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64&digest=sha256:xyz",
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64&digest=sha256:" + "0" * 64,
        "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64&cell=a&cell=b",
    ],
)
def test_uri_bad_cell_or_digest(uri):
    with pytest.raises(LinkError):
        cell_and_digest(uri)


def test_uri_empty_cell_is_absent():
    uri = "tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64&cell="
    assert cell_and_digest(uri) == ("", "")
