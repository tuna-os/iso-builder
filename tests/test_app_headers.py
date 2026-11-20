"""tunaos.org reads iso.tunaos.org's public JSON from the browser.

The download page on tunaos.org fetches downloads.json (prebuilt ISOs and
TunaOS Media Writer releases) cross-origin, so iso.tunaos.org must send
Access-Control-Allow-Origin for it. The app is served by Workers static
assets, which take response headers from app/public/_headers.
"""
from pathlib import Path

ROOT = Path(__file__).parents[1]
PUBLIC = ROOT / 'app' / 'public'


def header_rules():
    """{path: {header: value}} from _headers: an unindented path line, then
    indented `Name: value` lines."""
    rules, current = {}, None
    for line in (PUBLIC / '_headers').read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if line[0].isspace():
            assert current, f'header line before any path: {line!r}'
            name, _, value = line.strip().partition(':')
            rules[current][name.strip()] = value.strip()
        else:
            current = line.strip()
            rules.setdefault(current, {})
    return rules


def test_public_json_is_readable_from_any_origin():
    rules = header_rules()
    for path in ('/downloads.json', '/catalog-snapshot.json'):
        assert rules.get(path, {}).get('Access-Control-Allow-Origin') == '*', path


def test_cors_rules_name_files_the_app_serves():
    # downloads.json is generated at deploy time (scripts/generate-downloads.py).
    for path in header_rules():
        name = path.lstrip('/')
        assert name == 'downloads.json' or (PUBLIC / name).is_file(), path
