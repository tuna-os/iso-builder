"""Real-code tests for scripts/retain-iso-artifact.py and its workflow wiring.

Fixtures are tiny byte strings; no storage, network or workflow dispatch.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / 'scripts/retain-iso-artifact.py'
spec = importlib.util.spec_from_file_location('iso_artifact', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def measurements(tmp_path, data, qualification='not-assessed', **over):
    rec = {
        'schemaVersion': 1, 'kind': 'diagnostic-build-measurements', 'qualification': qualification,
        'iso': {'sha256': digest(data), 'sizeBytes': len(data)},
        'loadedWasm': {'sha256': digest(b'wasm'), 'sizeBytes': 4},
        'browser': {'product': 'HeadlessChrome/140.0.1.2', 'userAgent': 'fixture'},
        'phasesMs': {'inspect': 1, 'build': 2, 'save': 3},
    }
    if qualification == 'diagnostic-unqualified':
        rec['diagnosticUnqualified'] = {'label': 'diagnostic, unqualified build', 'image': 'tuna-os/skipjack:gnome',
                                        'platform': 'linux/amd64', 'gateReason': 'unqualified (incomplete-qualification-provenance)'}
    rec.update(over)
    path = tmp_path / 'measurements.json'
    path.write_text(json.dumps(rec))
    return path


@pytest.fixture
def iso(tmp_path):
    data = bytes(range(256)) * 20 + b'tail'  # 5124 bytes -> 3 chunks of 2048
    path = tmp_path / 'skipjack-gnome.iso'
    path.write_bytes(data)
    return path, data


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], text=True, capture_output=True)


def split(tmp_path, iso, qualification='not-assessed', chunk=2048, out='out', over=None,
          diagnostic_unqualified=None):
    path, data = iso
    meas = measurements(tmp_path, data, qualification, **(over or {}))
    if diagnostic_unqualified is None:
        diagnostic_unqualified = qualification == 'diagnostic-unqualified'
    return run('split', '--iso', str(path), '--measurements', str(meas), '--out', str(tmp_path / out),
               '--diagnostic-unqualified', str(diagnostic_unqualified).lower(),
               '--slug', 'skipjack-gnome', '--chunk-bytes', str(chunk), '--run-id', '7', '--run-attempt', '1',
               '--repository', 'tuna-os/iso-builder', '--sha', 'a' * 40)


def test_split_records_whole_and_per_chunk_hashes(tmp_path, iso):
    r = split(tmp_path, iso)
    assert r.returncode == 0, r.stderr
    data = iso[1]
    manifest = json.loads((tmp_path / 'out/manifest.json').read_text())
    assert json.loads(r.stdout) == manifest
    assert manifest['iso'] == {'sha256': digest(data), 'sizeBytes': len(data)}
    assert manifest['qualification'] == 'not-assessed' and manifest['r2'] is False
    assert [c['sizeBytes'] for c in manifest['chunks']] == [2048, 2048, 1028]
    assert [c['offset'] for c in manifest['chunks']] == [0, 2048, 4096]
    for c in manifest['chunks']:
        part = (tmp_path / 'out' / c['name']).read_bytes()
        assert c['sha256'] == digest(part) and c['sizeBytes'] == len(part)
        assert part == data[c['offset']:c['offset'] + c['sizeBytes']]
    assert manifest['producer'] == {'repository': 'tuna-os/iso-builder', 'runId': '7', 'runAttempt': '1', 'sha': 'a' * 40}
    assert manifest['measurements']['loadedWasm']['sha256'] == digest(b'wasm')


def test_round_trip_restores_identical_bytes(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    restored = tmp_path / 'restored.iso'
    r = run('verify', '--dir', str(tmp_path / 'out'), '--expected-sha256', digest(iso[1]), '--output', str(restored))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)['verified'] is True
    assert restored.read_bytes() == iso[1]


def test_diagnostic_label_is_carried_into_the_manifest(tmp_path, iso):
    r = split(tmp_path, iso, qualification='diagnostic-unqualified')
    assert r.returncode == 0, r.stderr
    manifest = json.loads(r.stdout)
    assert manifest['qualification'] == 'diagnostic-unqualified'
    assert manifest['measurements']['diagnosticUnqualified']['label'] == 'diagnostic, unqualified build'


def test_diagnostic_round_trip_requires_matching_explicit_flag(tmp_path, iso):
    assert split(tmp_path, iso, qualification='diagnostic-unqualified').returncode == 0
    out = tmp_path / 'out'
    refused = run('verify', '--dir', str(out), '--diagnostic-unqualified', 'false')
    assert refused.returncode != 0 and 'diagnostic-unqualified context' in refused.stderr
    restored = tmp_path / 'restored.iso'
    result = run('verify', '--dir', str(out), '--diagnostic-unqualified', 'true',
                 '--expected-sha256', digest(iso[1]), '--output', str(restored))
    assert result.returncode == 0, result.stderr
    assert restored.read_bytes() == iso[1]
    assert json.loads(result.stdout)['qualification'] == 'diagnostic-unqualified'


@pytest.mark.parametrize('qualification,requested', [
    ('not-assessed', True), ('diagnostic-unqualified', False),
])
def test_split_refuses_flag_mismatch_without_writing_artifacts(tmp_path, iso, qualification, requested):
    result = split(tmp_path, iso, qualification=qualification, diagnostic_unqualified=requested)
    assert result.returncode != 0 and 'diagnostic-unqualified context' in result.stderr
    assert not (tmp_path / 'out').exists()


@pytest.mark.parametrize('stale_block', [None, False, {}, {
    'label': 'diagnostic, unqualified build', 'image': 'tuna-os/skipjack:gnome',
    'platform': 'linux/amd64',
}])
def test_observed_retention_refuses_stale_diagnostic_block(tmp_path, iso, stale_block):
    result = split(tmp_path, iso, over={'diagnosticUnqualified': stale_block})
    assert result.returncode != 0 and 'diagnosticUnqualified block' in result.stderr
    assert not (tmp_path / 'out').exists()


def test_verify_refuses_relabeling_old_diagnostic_artifact_as_observed(tmp_path, iso):
    assert split(tmp_path, iso, qualification='diagnostic-unqualified').returncode == 0
    path = tmp_path / 'out/manifest.json'
    manifest = json.loads(path.read_text())
    manifest['qualification'] = 'not-assessed'
    path.write_text(json.dumps(manifest))
    restored = tmp_path / 'not-restored.iso'
    result = run('verify', '--dir', str(path.parent), '--diagnostic-unqualified', 'false',
                 '--output', str(restored))
    assert result.returncode != 0 and 'diagnosticUnqualified block' in result.stderr
    assert not restored.exists()


def test_verify_refuses_diagnostic_context_for_observed_artifact(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    result = run('verify', '--dir', str(tmp_path / 'out'), '--diagnostic-unqualified', 'true')
    assert result.returncode != 0 and 'diagnostic-unqualified context' in result.stderr


def test_verify_refuses_manifest_with_stale_iso_measurement(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    path = tmp_path / 'out/manifest.json'
    manifest = json.loads(path.read_text())
    manifest['measurements']['iso']['sha256'] = digest(b'another ISO')
    path.write_text(json.dumps(manifest))
    result = run('verify', '--dir', str(path.parent))
    assert result.returncode != 0 and 'measurements differ from the retained ISO' in result.stderr


@pytest.mark.parametrize('label', ['qualified', 'verified', '', None])
def test_refuses_any_other_qualification_label(tmp_path, iso, label):
    r = split(tmp_path, iso, qualification=label)
    assert r.returncode != 0 and 'qualification must be one of' in r.stderr


def test_refuses_diagnostic_label_without_diagnostic_block(tmp_path, iso):
    r = split(tmp_path, iso, qualification='diagnostic-unqualified', over={'diagnosticUnqualified': None})
    assert r.returncode != 0 and 'diagnosticUnqualified' in r.stderr


def test_refuses_measurements_of_different_bytes(tmp_path, iso):
    r = split(tmp_path, iso, over={'iso': {'sha256': digest(b'other'), 'sizeBytes': len(iso[1])}})
    assert r.returncode != 0 and 'differ from the browser measurements' in r.stderr
    r = split(tmp_path, iso, out='out2', over={'iso': {'sha256': digest(iso[1]), 'sizeBytes': 1}})
    assert r.returncode != 0 and 'differ from the browser measurements' in r.stderr


def test_refuses_nonempty_output_and_too_many_chunks(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    assert 'not empty' in split(tmp_path, iso).stderr
    r = split(tmp_path, iso, chunk=1024, out='many')
    assert r.returncode == 0  # 6 chunks is fine
    small = tmp_path / 'big.iso'
    small.write_bytes(b'x' * 70 * 1024)
    meas = measurements(tmp_path, small.read_bytes())
    r = run('split', '--iso', str(small), '--measurements', str(meas), '--out', str(tmp_path / 'toomany'),
            '--slug', 'big', '--chunk-bytes', '1024')
    assert r.returncode != 0 and 'exceeds 64' in r.stderr


def test_verify_detects_corruption_truncation_extra_and_wrong_expected_hash(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    out = tmp_path / 'out'
    good = digest(iso[1])
    assert run('verify', '--dir', str(out), '--expected-sha256', digest(b'other')).returncode != 0
    part = out / 'skipjack-gnome.iso.part0001'
    original = part.read_bytes()
    part.write_bytes(bytes([original[0] ^ 0xFF]) + original[1:])  # same size, one byte flipped
    r = run('verify', '--dir', str(out), '--expected-sha256', good)
    assert r.returncode != 0 and 'part0001 differs' in r.stderr
    part.write_bytes(original[:-1])
    assert 'differs from manifest' in run('verify', '--dir', str(out)).stderr
    part.write_bytes(original)
    (out / 'skipjack-gnome.iso.part0009').write_bytes(b'x')
    assert 'unexpected chunk files' in run('verify', '--dir', str(out)).stderr
    (out / 'skipjack-gnome.iso.part0009').unlink()
    (out / 'skipjack-gnome.iso.part0002').unlink()
    assert run('verify', '--dir', str(out)).returncode != 0
    assert not (tmp_path / 'never.iso').exists()


def test_verify_refuses_a_tampered_manifest_label(tmp_path, iso):
    assert split(tmp_path, iso).returncode == 0
    mf = tmp_path / 'out/manifest.json'
    manifest = json.loads(mf.read_text())
    manifest['qualification'] = 'qualified'
    mf.write_text(json.dumps(manifest))
    r = run('verify', '--dir', str(tmp_path / 'out'))
    assert r.returncode != 0 and 'qualification label invalid' in r.stderr


def plan(env):
    return subprocess.run([sys.executable, 'scripts/plan-full-matrix.py'], cwd=ROOT, env={**os.environ, **env}, text=True, capture_output=True)


def valid():
    return dict(RETAIN_ISO_ARTIFACT='true', RUN_FULL='true', ONLY='skipjack-gnome', BENCHMARK='false',
                KEEP_ISO='false', RETAIN_ISO_ARTIFACT_DAYS='7', RETAIN_CANDIDATE='false',
                STRICT_INSTALL_MODE='plain', DIAGNOSTIC_UNQUALIFIED='false', STRICT_ROUNDTRIP_TEST='false')


def test_plan_accepts_any_single_named_cell_without_r2():
    r = plan(valid())
    assert r.returncode == 0, r.stderr
    assert 'count=1' in r.stdout and '"slug": "skipjack-gnome"' in r.stdout


def test_plan_step_writes_matrix_outputs(tmp_path):
    # Runs the workflow's own step command: an output-suppressing invocation
    # once left editions/count empty, so full-matrix was never created.
    pick = next(s for s in WORKFLOW['jobs']['full-plan']['steps'] if s.get('id') == 'pick')
    out = tmp_path / 'github_output'
    r = subprocess.run(['bash', '-e', '-c', pick['run']], cwd=ROOT, text=True, capture_output=True,
                       env={**os.environ, **valid(), 'GITHUB_OUTPUT': str(out)})
    assert r.returncode == 0, r.stderr
    lines = out.read_text().splitlines()
    assert 'count=1' in lines
    assert any(line.startswith('editions=') and '"slug": "skipjack-gnome"' in line for line in lines)


@pytest.mark.parametrize('key,value', [('ONLY', ''), ('ONLY', 'skipjack-gnome,bonito-kde'), ('RUN_FULL', 'false'),
                                       ('BENCHMARK', 'true'), ('KEEP_ISO', 'true'), ('RETAIN_ISO_ARTIFACT_DAYS', '0'),
                                       ('RETAIN_ISO_ARTIFACT_DAYS', '91'), ('RETAIN_ISO_ARTIFACT_DAYS', 'x')])
def test_plan_rejects_unbounded_scope(key, value):
    env = valid()
    env[key] = value
    r = plan(env)
    assert r.returncode != 0 and 'ISO artifact retention requires' in r.stderr

@pytest.mark.parametrize('mode,diagnostic', [('plain', 'false'), ('luks', 'true')])
def test_strict_roundtrip_plan_accepts_bounded_observed_or_diagnostic_cell(mode, diagnostic):
    env = valid()
    env.update(STRICT_ROUNDTRIP_TEST='true', STRICT_INSTALL_MODE=mode, DIAGNOSTIC_UNQUALIFIED=diagnostic)
    r = plan(env)
    assert r.returncode == 0, r.stderr
    assert 'count=1' in r.stdout and '"slug": "skipjack-gnome"' in r.stdout


@pytest.mark.parametrize('key,value', [
    ('ONLY', 'bonito-kde'), ('RUN_FULL', 'false'), ('BENCHMARK', 'true'),
    ('KEEP_ISO', 'true'), ('STRICT_INSTALL_MODE', 'both'), ('STRICT_INSTALL_MODE', ''),
    ('RETAIN_ISO_ARTIFACT', 'false'), ('RETAIN_CANDIDATE', 'true'),
])
def test_strict_roundtrip_plan_rejects_unbounded_or_published_modes(key, value):
    env = valid()
    env.update(STRICT_ROUNDTRIP_TEST='true')
    env[key] = value
    r = plan(env)
    assert r.returncode != 0


@pytest.mark.parametrize('mode,diagnostic', [('plain', 'true'), ('luks', 'false'),
                                           ('plain', 'invalid')])
def test_strict_roundtrip_plan_rejects_mismatched_diagnostic_mode(mode, diagnostic):
    env = valid()
    env.update(STRICT_ROUNDTRIP_TEST='true', STRICT_INSTALL_MODE=mode, DIAGNOSTIC_UNQUALIFIED=diagnostic)
    assert plan(env).returncode != 0


def test_strict_choice_does_not_change_normal_full_route():
    env = valid()
    env.update(RETAIN_ISO_ARTIFACT='false', ONLY='', STRICT_INSTALL_MODE='luks')
    assert plan(env).returncode == 0
