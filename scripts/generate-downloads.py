#!/usr/bin/env python3
"""Write app/public/downloads.json for the one-click download view.

Two sources, read at deploy time so the page never carries a hand-copied list:
  - prebuilt ISOs: the published index tunaos.org serves (iso-index.json,
    built by tuna-os/docs from the R2 listing). Only the amd64 "-latest" live
    ISOs, keyed "<variant>-<flavor>" exactly as quick-start.js looks them up.
  - TunaOS Media Writer: the newest non-draft, non-prerelease GitHub release of
    this repository tagged media-writer-v*, keyed by platform.

A source that cannot be read leaves its section empty and prints a GitHub
Actions warning: the page then offers fewer routes, never a dead link.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import urllib.request

INDEX_URL = "https://tunaos.org/iso-index.json"
RELEASES_URL = "https://api.github.com/repos/tuna-os/iso-builder/releases?per_page=30"
LATEST = re.compile(r"^([a-z0-9]+(?:-[a-z0-9]+)*)-latest$")
ISO_HOST = "https://download.tunaos.org/"
RELEASE_HOST = "https://github.com/tuna-os/iso-builder/releases/download/"
MEDIA_WRITER_ASSETS = {
    "TunaOS-Media-Writer-macOS.dmg": "macos",
    "TunaOS-Media-Writer-Windows-x64.msi": "windows-x64",
    "TunaOS-Media-Writer-Linux-x86_64.flatpak": "linux-x86_64",
    "TunaOS-Media-Writer-Linux-aarch64.flatpak": "linux-aarch64",
}


def fetch_json(url: str, token: str | None = None):
    headers = {"Accept": "application/json", "User-Agent": "tuna-os-iso-builder-deploy"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        return json.load(response)


def prebuilt_from_index(index: dict) -> dict:
    out = {}
    for category in index.get("categories", []):
        if category.get("id") != "live-isos":
            continue
        for iso in category.get("isos", []):
            match = LATEST.match(str(iso.get("name", "")))
            url, size = iso.get("url"), iso.get("size")
            if (not match or not iso.get("latest") or iso.get("arch") not in ("", "x86_64")
                    or not isinstance(url, str) or not url.startswith(ISO_HOST) or not url.endswith(".iso")
                    or not isinstance(size, int) or size <= 0):
                continue
            key = match.group(1)
            if re.search(r"(?:^|-)(?:arm64|aarch64)$", key):
                continue
            out[key] = {"url": url, "size": size, "modified": iso.get("modified")}
    return dict(sorted(out.items()))


def media_writer_from_releases(releases: list) -> dict | None:
    for release in releases:
        tag = str(release.get("tag_name", ""))
        if release.get("draft") or release.get("prerelease") or not tag.startswith("media-writer-v"):
            continue
        assets = {}
        for asset in release.get("assets", []):
            key = MEDIA_WRITER_ASSETS.get(asset.get("name"))
            url = asset.get("browser_download_url")
            if key and isinstance(url, str) and url.startswith(RELEASE_HOST) and asset.get("state", "uploaded") == "uploaded":
                assets[key] = {"url": url, "size": asset.get("size")}
        if assets:
            return {"version": tag.removeprefix("media-writer-v"), "assets": assets}
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="app/public/downloads.json")
    parser.add_argument("--index-url", default=INDEX_URL)
    parser.add_argument("--releases-url", default=RELEASES_URL)
    args = parser.parse_args()

    doc = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": {"prebuilt": args.index_url, "mediaWriter": args.releases_url},
        "prebuilt": {},
        "mediaWriter": None,
    }
    try:
        doc["prebuilt"] = prebuilt_from_index(fetch_json(args.index_url))
    except Exception as error:  # noqa: BLE001 - any failure only drops the route
        print(f"::warning::prebuilt ISO index unavailable ({error}); the download page offers no ready-made ISOs")
    try:
        doc["mediaWriter"] = media_writer_from_releases(fetch_json(args.releases_url, os.environ.get("GITHUB_TOKEN")))
    except Exception as error:  # noqa: BLE001
        print(f"::warning::release list unavailable ({error}); the download page offers no Media Writer app")
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=1, sort_keys=True)
        handle.write("\n")
    writer = doc["mediaWriter"]
    print(f"downloads.json: {len(doc['prebuilt'])} prebuilt ISOs, media writer "
          f"{writer['version'] + ' ' + ','.join(sorted(writer['assets'])) if writer else 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
