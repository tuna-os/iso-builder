"""Incomplete catalog assertions must not enable browser builds (#270)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from ci_sources import workflow_text  # noqa: E402
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
    src = (ROOT / 'app/public/app.js').read_text()
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
    src = (ROOT / 'app/public/app.js').read_text()
    embedded = json.loads(src.split('const DEFAULT_CATALOG_SNAPSHOT = ', 1)[1].split(';\n', 1)[0])
    assert embedded == doc
    assert all(e['qualification']['status'] != 'qualified' or vc.qualification_provenance_complete(e) for e in doc['targets'])


def test_strict_path_cannot_receive_generic_image_injection():
    workflow = workflow_text()  # ci.yml plus the justfile recipes its steps run
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


# --- receipt-backed entries (tunaOS generate-catalog-snapshot.py) -------------

SNAPSHOT = json.loads((ROOT / 'app/public/catalog-snapshot.json').read_text())


def receipt_entry(platform='linux/amd64'):
    """The projection tunaOS writes for a committed BrowserIsoQualificationReceipt/v1."""
    entry = next(copy.deepcopy(e) for e in SNAPSHOT['targets']
                 if e['availability']['available'] and e['target']['platform'] == platform)
    digest = 'sha256:' + '4' * 64
    ri = entry['resolvedInputs']
    basis = ri['platformManifestDigest'] if platform == 'linux/amd64' else 'sha256:' + '5' * 64
    if platform == 'linux/amd64':
        ri.update(liveOverlayDigest=digest, liveOverlayBaseDigest=ri['platformManifestDigest'],
                  installerRevision=digest, engineRevision=digest)
    entry['qualification'] = {
        'browser': None, 'browserBuildReceiptDigest': None, 'buildOrigin': 'browser',
        'isoDigest': 'sha256:' + '2' * 64,
        'producer': {'repository': 'tuna-os/iso-builder', 'workflow': '.github/workflows/ci.yml',
                     'ref': 'refs/heads/main', 'sha': '3' * 40, 'runId': 19000000001, 'runAttempt': 1},
        'qualifiedAt': '2026-11-04T09:30:00Z', 'reason': None, 'receiptDigest': 'sha256:' + '6' * 64,
        'receiptImageDigest': basis, 'receiptPlatform': 'linux/amd64',
        'receiptSchema': 'BrowserIsoQualificationReceipt/v1', 'resources': None, 'status': 'qualified',
    }
    return entry


@pytest.mark.parametrize('platform', ['linux/amd64', 'linux/arm64'])
def test_receipt_backed_entry_passes_without_browser_profile(platform):
    e = receipt_entry(platform)
    assert vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'qualified'


@pytest.mark.parametrize('path,value', [
    (('receiptSchema',), 'BrowserIsoQualificationReceipt/v2'),
    (('receiptPlatform',), 'linux/arm64'), (('receiptImageDigest',), 'sha256:' + '7' * 64),
    (('receiptImageDigest',), None), (('isoDigest',), None), (('receiptDigest',), 'tacklebox-1.0'),
    (('buildOrigin',), 'native'), (('qualifiedAt',), '2026-11-04'),
    (('producer', 'repository'), 'someone/iso-builder'), (('producer', 'workflow'), '.github/workflows/other.yml'),
    (('producer', 'ref'), 'refs/heads/feature'), (('producer', 'sha'), 'abc'),
    (('producer', 'runId'), 0), (('producer', 'runId'), True), (('producer', 'runAttempt'), '1'),
    (('producer',), None),
])
def test_receipt_backed_entry_needs_every_receipt_binding(path, value):
    e = receipt_entry()
    holder = e['qualification']
    for key in path[:-1]:
        holder = holder[key]
    holder[path[-1]] = value
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


@pytest.mark.parametrize('field', ['liveOverlayDigest', 'liveOverlayBaseDigest', 'installerRevision', 'engineRevision'])
def test_receipt_backed_amd64_entry_needs_its_receipt_inputs(field):
    e = receipt_entry()
    e['resolvedInputs'][field] = None
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


def test_receipt_basis_cannot_qualify_other_platforms():
    e = receipt_entry('linux/arm64')
    e['target']['platform'] = 'linux/amd64/v2'
    assert not vc.qualification_provenance_complete(e)
    assert browser_status(e) == 'unqualified'


def _write_snapshot(tmp_path, targets):
    doc = copy.deepcopy(SNAPSHOT)
    doc['targets'] = targets
    canonical = json.dumps(targets, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    doc['snapshotDigest'] = 'sha256:' + hashlib.sha256(canonical).hexdigest()
    path = tmp_path / 'catalog-snapshot.json'
    path.write_text(json.dumps(doc))
    return path


def test_arm64_entry_must_cite_the_receipt_of_its_published_amd64_target(tmp_path):
    by_key = {e['targetKey']: e for e in SNAPSHOT['targets']}
    variant, flavor = next((t['variant'], t['flavor']) for t in (e['target'] for e in SNAPSHOT['targets'])
                           if t['platform'] == 'linux/arm64'
                           and f"{t['variant']}:{t['flavor']}:linux/amd64" in by_key
                           and by_key[f"{t['variant']}:{t['flavor']}:linux/amd64"]['availability']['available'])
    amd64 = copy.deepcopy(by_key[f'{variant}:{flavor}:linux/amd64'])
    arm64 = copy.deepcopy(by_key[f'{variant}:{flavor}:linux/arm64'])
    arm64['qualification'] = receipt_entry('linux/arm64')['qualification']
    arm64['qualification']['receiptImageDigest'] = amd64['resolvedInputs']['platformManifestDigest']
    assert vc.validate_snapshot(_write_snapshot(tmp_path, [amd64, arm64]))
    arm64['qualification']['receiptImageDigest'] = 'sha256:' + '8' * 64
    with pytest.raises(SystemExit, match='cites a receipt'):
        vc.validate_snapshot(_write_snapshot(tmp_path, [amd64, arm64]))


def test_imported_snapshot_copies_and_guided_catalog_agree():
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/sync-catalog-snapshot.py'), '--check'],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr


# --- nvidia targets inherit their sibling's receipt (tunaOS iso_delivery `inherits`) ----

def inherited_pair():
    """(sibling, nvidia) entries: the nvidia one carries the sibling's receipt with
    `inheritedFrom`, its own image and its own overlay built on that image."""
    sibling = receipt_entry()
    nvidia = copy.deepcopy(sibling)
    t = nvidia['target']
    sibling['target'].update(variant='fish', flavor='gnome')
    sibling['targetKey'] = 'fish:gnome:linux/amd64'
    t.update(variant='fish', flavor='gnome-nvidia')
    nvidia['targetKey'] = 'fish:gnome-nvidia:linux/amd64'
    image = 'sha256:' + '9' * 64
    nvidia['resolvedInputs'].update(platformManifestDigest=image, liveOverlayBaseDigest=image,
                                    liveOverlayDigest='sha256:' + 'a' * 64)
    nvidia['qualification']['inheritedFrom'] = 'fish:gnome:linux/amd64'
    return sibling, nvidia


def test_an_inheriting_nvidia_entry_passes_without_its_own_receipt_image():
    sibling, nvidia = inherited_pair()
    assert nvidia['qualification']['receiptImageDigest'] != nvidia['resolvedInputs']['platformManifestDigest']
    assert vc.qualification_provenance_complete(nvidia)
    assert browser_status(nvidia) == 'qualified'


@pytest.mark.parametrize('mutate', [
    lambda s, n: n['qualification'].update(inheritedFrom='fish:kde:linux/amd64'),       # not its sibling
    lambda s, n: n['qualification'].update(inheritedFrom='other:gnome:linux/amd64'),    # another variant
    lambda s, n: n['qualification'].update(inheritedFrom=''),
    lambda s, n: n['target'].update(flavor='gnome'),                                    # not an nvidia flavor
    lambda s, n: n['resolvedInputs'].update(liveOverlayBaseDigest='sha256:' + 'b' * 64),  # overlay of other bytes
])
def test_a_malformed_inheritance_is_refused(mutate):
    """Falsification: accepting any `inheritedFrom` would let an unrelated image
    borrow a receipt; the JS and Python gates must refuse the same shapes."""
    sibling, nvidia = inherited_pair()
    mutate(sibling, nvidia)
    assert not vc.qualification_provenance_complete(nvidia)
    assert browser_status(nvidia) == 'unqualified'


def test_the_snapshot_validator_follows_inheritedFrom_to_a_sibling_on_the_same_receipt(tmp_path):
    sibling, nvidia = inherited_pair()

    def validate(entries):
        targets = sorted(entries, key=lambda e: e['targetKey'])
        canonical = json.dumps(targets, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                               allow_nan=False).encode()
        doc = {'schemaVersion': 1, 'kind': 'catalog-snapshot', 'coverageDigest': 'sha256:' + '0' * 64,
               'snapshotDigest': 'sha256:' + hashlib.sha256(canonical).hexdigest(), 'targets': targets}
        path = tmp_path / 'snap.json'
        path.write_text(json.dumps(doc))
        return vc.validate_snapshot(path)

    assert validate([sibling, nvidia])
    other = copy.deepcopy(sibling)
    other['qualification']['receiptDigest'] = 'sha256:' + 'c' * 64
    with pytest.raises(SystemExit, match='not qualified on the same receipt'):
        validate([other, nvidia])
    unqualified = copy.deepcopy(sibling)
    unqualified['qualification'] = {'status': 'unqualified', 'reason': 'x'}
    with pytest.raises(SystemExit, match='not qualified on the same receipt'):
        validate([unqualified, nvidia])
