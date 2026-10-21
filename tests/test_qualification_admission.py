"""Incomplete catalog assertions must not enable browser builds (#270)."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT / 'scripts/verify-catalog.py')
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)


def valid_entry():
    entry = next(copy.deepcopy(e) for e in json.loads((ROOT / 'app/public/catalog-snapshot.json').read_text())['targets'] if e['availability']['available'])
    digest = 'sha256:' + '1' * 64
    entry['resolvedInputs'].update(liveOverlayDigest=digest, liveOverlayBaseDigest=entry['resolvedInputs']['platformManifestDigest'], engineRevision=digest, installerRevision=digest)
    entry['qualification'].update(buildOrigin='browser', browserBuildReceiptDigest=digest, isoDigest=digest, status='qualified', reason=None, receiptDigest=digest, qualifiedAt='2026-10-19T00:00:00Z', browser=dict(name='chromium', version='123.0', memory_gib=16, free_disk_gib=40))
    return entry


def browser_status(entry):
    src = (ROOT / 'app/public/catalog.js').read_text()
    start = src.index('function catalogQualification(')
    fn = src[start:src.index('\n}\n', start) + 3]
    script = fn + '\nprocess.stdout.write(catalogQualification(JSON.parse(process.argv[1])).status);'
    return subprocess.check_output(['node', '-e', script, json.dumps(entry)], text=True)


@pytest.mark.parametrize('field,value', [
    ('liveOverlayDigest', None), ('liveOverlayBaseDigest', None),
    ('engineRevision', 'tacklebox-1.0'), ('installerRevision', 'remora-1.0'),
    ('platformManifestDigest', None), ('liveOverlayBaseDigest', 'sha256:' + '2' * 64),
])
def test_missing_or_mismatched_input_is_unqualified(field, value):
    e = valid_entry()
    e['resolvedInputs'][field] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('field,value', [('name', 'native'), ('name', ''), ('version', None), ('memory_gib', 0), ('free_disk_gib', -1), ('memory_gib', True)])
def test_missing_browser_prerequisites_are_unqualified(field, value):
    e = valid_entry()
    e['qualification']['browser'][field] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


def test_complete_metadata_passes_minimum_gate_only():
    e = valid_entry()
    assert vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'qualified'


def test_shipped_catalogs_and_embedded_fallback_share_truthful_status():
    raw = (ROOT / 'app/public/catalog-snapshot.json').read_bytes()
    assert raw == (ROOT / 'native/catalog-snapshot.json').read_bytes()
    doc = vc.validate_snapshot()
    src = (ROOT / 'app/public/catalog.js').read_text()
    embedded = json.loads(src.split('const DEFAULT_CATALOG_SNAPSHOT = ', 1)[1].split(';\n', 1)[0])
    assert embedded == doc
    assert all(e['qualification']['status'] != 'qualified' or vc.qualification_provenance_complete(e) for e in doc['targets'])


def test_strict_path_cannot_receive_generic_image_injection():
    workflow = (ROOT / '.github/workflows/ci.yml').read_text()
    strict = next(line for line in workflow.splitlines() if 'sudo ' in line and '--strict-offline-gui' in line)
    assert 'env -u TBOX_E2E_IMAGE' in strict
    assert 'TBOX_E2E_IMAGE="$TBOX_E2E_IMAGE"' not in strict
    assert 'sudo TBOX_E2E_IMAGE="$TBOX_E2E_IMAGE"' in workflow  # reference path retained


@pytest.mark.parametrize('stamp', ['2026', 'October 19, 2026', '2026-10-19',
                                 '2026-02-30T00:00:00Z', '2026-10-19T25:00:00Z',
                                 '2026-10-19T00:00:00', 'not-a-date', None])
def test_timestamp_contract_is_utc_seconds_in_both_consumers(stamp):
    e = valid_entry()
    e['qualification']['qualifiedAt'] = stamp
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('name', [' native', '\tNATIVE-qemu ', '\nnative'])
def test_native_provenance_cannot_hide_behind_whitespace(name):
    e = valid_entry()
    e['qualification']['browser']['name'] = name
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('field', ['resolvedInputs', 'availability'])
@pytest.mark.parametrize('value', [[], 'bad', 7])
def test_wrong_type_inputs_fail_closed(field, value):
    e = valid_entry()
    e[field] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('field,value', [('name', 'unknown'), ('name', ' n/a '),
                                         ('version', 'unknown'), ('version', 'placeholder')])
def test_placeholder_browser_profile_is_unqualified(field, value):
    e = valid_entry()
    e['qualification']['browser'][field] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('field,value', [('buildOrigin', None), ('buildOrigin', 'native'),
                                         ('browserBuildReceiptDigest', None), ('isoDigest', None)])
def test_build_origin_and_artifact_binding_are_required(field, value):
    e = valid_entry()
    e['qualification'][field] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'
