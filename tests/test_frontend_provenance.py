"""Tiny response records only; these do not authenticate a browser or boot."""
import copy
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('provenance_frontend', Path(__file__).parents[1] / 'scripts/collect-candidate-provenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


@pytest.fixture
def observed():
    origin = 'http://127.0.0.1:8931'
    doc = origin + '/?image=yellowfin%3Agnome&autodl=1&autorun=1'
    files, assets = {}, []
    for name in sorted(m.FRONTEND_REQUIRED):
        measurement = {'sha256': 'sha256:' + 'a' * 64, 'sizeBytes': 7}
        files['app/public/' + name] = measurement
        assets.append({**measurement, 'url': doc if name == 'index.html' else origin + '/' + name,
                       'resourceType': 'document' if name == 'index.html' else 'wasm' if name == 'tbox.wasm' else 'script',
                       'responseCount': 1})
    record = {'schemaVersion': 1, 'kind': 'diagnostic-loaded-frontend', 'qualification': 'not-assessed',
              'authentication': 'not-verified', 'coverage': 'page-target-only',
              'origin': origin, 'documentURL': doc, 'assets': assets}
    return record, files


def test_matching_loaded_bytes_remain_unauthenticated(observed):
    result = m.bind_loaded_frontend(*observed)
    assert result['status'] == 'observed-bytes-match-served-tree'
    assert result['authentication'] == 'not-verified'
    assert result['files'] == observed[1]
    assert 'receiptDigest' not in result


@pytest.mark.parametrize('key,value', [
    ('schemaVersion', True), ('schemaVersion', 2),
    ('coverage', 'all-browser-targets'),
    ('kind', 'qualified-receipt'), ('qualification', 'qualified'), ('authentication', 'verified'),
    ('origin', 'https://attacker.invalid'), ('origin', 'http://localhost:8931'),
    ('documentURL', 'http://127.0.0.1:8931/other'), ('assets', []),
])
def test_bad_frontend_context(observed, key, value):
    observed[0][key] = value
    with pytest.raises(ValueError):
        m.bind_loaded_frontend(*observed)


@pytest.mark.parametrize('key,value', [
    ('sha256', 'sha256:' + 'b' * 64), ('sizeBytes', True), ('sizeBytes', 8),
    ('url', 'http://127.0.0.1:8931.evil/app.js'), ('url', 'http://127.0.0.1:8931/app.js?other'),
    ('url', 'http://127.0.0.1:8931/../app.js'), ('url', 'http://127.0.0.1:8931/%61pp.js'),
    ('resourceType', 'fetch'), ('responseCount', True), ('responseCount', 0),
])
def test_bad_asset(observed, key, value):
    asset = next(a for a in observed[0]['assets'] if a['url'].endswith('/app.js'))
    asset[key] = value
    with pytest.raises(ValueError):
        m.bind_loaded_frontend(*observed)


def test_missing_main_script(observed):
    observed[0]['assets'] = [a for a in observed[0]['assets'] if not a['url'].endswith('/app.js')]
    with pytest.raises(ValueError, match='missing'):
        m.bind_loaded_frontend(*observed)


def test_unknown_loaded_script(observed):
    asset = copy.deepcopy(observed[0]['assets'][0])
    asset['url'] = observed[0]['origin'] + '/surprise.js'
    observed[0]['assets'].append(asset)
    with pytest.raises(ValueError):
        m.bind_loaded_frontend(*observed)


def test_duplicate_response_record(observed):
    observed[0]['assets'].append(copy.deepcopy(observed[0]['assets'][0]))
    with pytest.raises(ValueError, match='duplicate'):
        m.bind_loaded_frontend(*observed)


def test_repeated_main_navigation(observed):
    next(a for a in observed[0]['assets'] if a['resourceType'] == 'document')['responseCount'] = 2
    with pytest.raises(ValueError, match='navigation'):
        m.bind_loaded_frontend(*observed)


def test_optional_script_named_layerworker_must_match_served_bytes(observed):
    measurement = {'sha256': 'sha256:' + 'c' * 64, 'sizeBytes': 9}
    observed[1]['app/public/layerworker.js'] = measurement
    observed[0]['assets'].append({**measurement, 'url': observed[0]['origin'] + '/layerworker.js',
                                 'resourceType': 'script', 'responseCount': 1})
    assert 'app/public/layerworker.js' in m.bind_loaded_frontend(*observed)['files']
    observed[0]['assets'][-1]['sha256'] = 'sha256:' + 'd' * 64
    with pytest.raises(ValueError, match='served bytes'):
        m.bind_loaded_frontend(*observed)


def test_wasm_resource_type(observed):
    next(a for a in observed[0]['assets'] if a['url'].endswith('/tbox.wasm'))['resourceType'] = 'fetch'
    with pytest.raises(ValueError, match='WASM'):
        m.bind_loaded_frontend(*observed)


def test_aggregate_response_limit(observed):
    observed[0]['assets'][0]['responseCount'] = 64
    with pytest.raises(ValueError, match='total limits'):
        m.bind_loaded_frontend(*observed)


def test_aggregate_byte_limit(observed):
    for asset in observed[0]['assets']:
        asset['sizeBytes'] = 20 * 1024**2
    for measured in observed[1].values():
        measured['sizeBytes'] = 20 * 1024**2
    with pytest.raises(ValueError, match='total limits'):
        m.bind_loaded_frontend(*observed)
