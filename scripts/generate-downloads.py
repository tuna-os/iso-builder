#!/usr/bin/env python3
"""Write app/public/downloads.json for the one-click download view.

Read at deploy time so the page never carries a hand-copied list. `prebuilt`
stays in the schema and is always empty: R2 holds no ISOs, and the page builds
each one from its GHCR image or hands it to Media Writer.
  - TunaOS Media Writer: the newest non-draft, non-prerelease GitHub release of
    this repository tagged media-writer-v*, keyed by platform.

A release list that cannot be read leaves the app out and prints a GitHub
Actions warning: the page then offers fewer routes, never a dead link.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.request

RELEASES_URL = "https://api.github.com/repos/tuna-os/iso-builder/releases?per_page=30"
RELEASE_HOST = "https://github.com/tuna-os/iso-builder/releases/download/"
MEDIA_WRITER_ASSETS = {
    "TunaOS-Media-Writer-macOS.dmg": "macos",
    "TunaOS-Media-Writer-Windows-x64.msi": "windows-x64",
    "TunaOS-Media-Writer-Linux-x86_64.flatpak": "linux-x86_64",
    "TunaOS-Media-Writer-Linux-aarch64.flatpak": "linux-aarch64",
}
# signing.json, attached by media-writer-release.yml, records what each
# platform job actually did. Only these values mean the OS will open the app
# without a warning; anything else (absent, adhoc, unsigned) shows the
# first-launch hint on the page.
SIGNING_ASSET = "signing.json"
TRUSTED_SIGNING = {"developer-id-notarized", "authenticode"}


def fetch_json(url: str, token: str | None = None):
    headers = {"Accept": "application/json", "User-Agent": "tuna-os-iso-builder-deploy"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        return json.load(response)


def media_writer_from_releases(releases: list, fetch=fetch_json) -> dict | None:
    for release in releases:
        tag = str(release.get("tag_name", ""))
        if release.get("draft") or release.get("prerelease") or not tag.startswith("media-writer-v"):
            continue
        assets, signing_url = {}, None
        for asset in release.get("assets", []):
            url = asset.get("browser_download_url")
            if not (isinstance(url, str) and url.startswith(RELEASE_HOST) and asset.get("state", "uploaded") == "uploaded"):
                continue
            if asset.get("name") == SIGNING_ASSET:
                signing_url = url
            elif key := MEDIA_WRITER_ASSETS.get(asset.get("name")):
                assets[key] = {"url": url, "size": asset.get("size")}
        if not assets:
            continue
        signing = {}
        if signing_url:
            try:
                signing = fetch(signing_url) or {}
            except Exception as error:  # noqa: BLE001 - unknown signing shows the hint
                print(f"::warning::{SIGNING_ASSET} of {tag} unreadable ({error}); treating every app as unsigned")
        for key, asset in assets.items():
            asset["signed"] = signing.get(key) in TRUSTED_SIGNING
        return {"version": tag.removeprefix("media-writer-v"), "assets": assets}
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="app/public/downloads.json")
    parser.add_argument("--releases-url", default=RELEASES_URL)
    args = parser.parse_args()

    doc = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": {"mediaWriter": args.releases_url},
        "prebuilt": {},
        "mediaWriter": None,
    }
    try:
        doc["mediaWriter"] = media_writer_from_releases(fetch_json(args.releases_url, os.environ.get("GITHUB_TOKEN")))
    except Exception as error:  # noqa: BLE001
        print(f"::warning::release list unavailable ({error}); the download page offers no Media Writer app")
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=1, sort_keys=True)
        handle.write("\n")
    writer = doc["mediaWriter"]
    print("downloads.json: " f"media writer "
          f"{writer['version'] + ' ' + ','.join(sorted(writer['assets'])) if writer else 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
