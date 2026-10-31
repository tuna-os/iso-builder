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
sys.path.insert(0, str(ROOT / 'tests'))
from ci_sources import recipe  # noqa: E402
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


def split(tmp_path, iso, qualification='not-assessed', chunk=2048, out='out', over=None):
    path, data = iso
    meas = measurements(tmp_path, data, qualification, **(over or {}))
    return run('split', '--iso', str(path), '--measurements', str(meas), '--out', str(tmp_path / out),
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


def test_roundtrip_verification_requires_successful_download():
    steps = WORKFLOW['jobs']['full-matrix']['steps']
    download = next(s for s in steps if s.get('id') == 'iso-artifact-download')
    verify = next(s for s in steps if s.get('id') == 'iso-roundtrip')
    assert download['uses'] == 'actions/download-artifact@v8'
    assert "steps.iso-artifact-download.outcome == 'success'" in verify['if']
    assert 'continue-on-error' not in download
    assert 'continue-on-error' not in verify


def plan(env):
    assert 'plan-full-matrix.py' in recipe('full-plan')
    return subprocess.run([sys.executable, 'scripts/plan-full-matrix.py'], cwd=ROOT, env={**os.environ, **env}, text=True, capture_output=True)


def valid():
    return dict(RETAIN_ISO_ARTIFACT='true', RUN_FULL='true', ONLY='skipjack-gnome', BENCHMARK='false',
                KEEP_ISO='false', RETAIN_ISO_ARTIFACT_DAYS='7', RETAIN_CANDIDATE='false')


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

def test_strict_roundtrip_plan_accepts_only_the_bounded_diagnostic_cell():
    env = valid()
    env.update(STRICT_ROUNDTRIP_TEST='true', DIAGNOSTIC_UNQUALIFIED='true')
    r = plan(env)
    assert r.returncode == 0, r.stderr
    assert 'count=1' in r.stdout and '"slug": "skipjack-gnome"' in r.stdout


@pytest.mark.parametrize('key,value', [
    ('ONLY', 'bonito-kde'), ('RUN_FULL', 'false'), ('BENCHMARK', 'true'),
    ('KEEP_ISO', 'true'), ('DIAGNOSTIC_UNQUALIFIED', 'false'),
    ('RETAIN_ISO_ARTIFACT', 'false'), ('RETAIN_CANDIDATE', 'true'),
])
def test_strict_roundtrip_plan_rejects_unbounded_or_published_modes(key, value):
    env = valid()
    env.update(STRICT_ROUNDTRIP_TEST='true', DIAGNOSTIC_UNQUALIFIED='true')
    env[key] = value
    r = plan(env)
    assert r.returncode != 0


def test_workflow_artifact_path_needs_no_secrets_and_defaults_off():
    inputs = WORKFLOW[True]['workflow_dispatch']['inputs'] if True in WORKFLOW else WORKFLOW['on']['workflow_dispatch']['inputs']
    assert inputs['retain_iso_artifact']['default'] is False
    assert inputs['retain_candidate']['default'] is False
    job = WORKFLOW['jobs']['full-matrix']
    names = [s.get('name', '') for s in job['steps']]
    first = names.index('retain ISO as GitHub artifact (chunked, sha256-verified)')
    last = names.index('verify ISO artifact round trip')
    for step in job['steps'][first:last + 1]:
        assert 'secrets.' not in yaml.safe_dump(step), step.get('name')
        assert 'always()' in step['if'] and '!cancelled()' in step['if']
    split_step = job['steps'][first]
    assert "steps.browser-build.outcome == 'success'" in split_step['if']
    upload = next(s for s in job['steps'] if s.get('name') == 'upload ISO chunks')
    assert upload['with']['compression-level'] == 0 and upload['with']['if-no-files-found'] == 'error'
    assert 'retain_iso_artifact_days' in upload['with']['retention-days']
    assert WORKFLOW['permissions'] == {'contents': 'read'}
    # The R2 path is untouched and still gated on its own input.
    assert "retain_candidate == 'true'" in next(s for s in job['steps'] if s.get('name', '').startswith('retain opt-in'))['if']


def test_strict_roundtrip_budget_covers_work_and_keeps_finalization_time():
    job = WORKFLOW['jobs']['full-matrix']
    steps = job['steps']

    def named(prefix):
        return next(s for s in steps if s.get('name', '').startswith(prefix))

    expression = job['timeout-minutes']
    assert "strict_roundtrip_test == 'true' && 360" in expression
    assert "retain_iso_artifact == 'true' && 330" in expression

    work = [
        named('build '),
        named('retain ISO as GitHub artifact'),
        named('upload ISO chunks'),
        named('upload ISO manifest'),
        named('drop local chunks'),
        named('download ISO artifact again'),
        named('verify ISO artifact round trip'),
        named('prepare strict inputs'),
        named('verify exact retained ISO'),
    ]
    # The plan refuses pair=true with retention, so the build step's budget is
    # its non-pair branch here.
    build = work[0]['timeout-minutes']
    assert build == "${{ github.event.inputs.pair == 'true' && 300 || 75 }}"
    minutes = [75] + [s['timeout-minutes'] for s in work[1:]]
    assert minutes == [75, 30, 30, 5, 5, 30, 30, 10, 60]
    assert sum(minutes) == 275

    setup = [
        steps[0],
        next(s for s in steps if s.get('with', {}).get('name') == 'engine'),
        next(s for s in steps if s.get('uses', '').startswith('actions/setup-node@')),
        named('Cache Playwright browsers'),
        named('install deps + chromium'),
        named('checkout current tunaOS strict harness'),
    ]
    assert [s['timeout-minutes'] for s in setup] == [5, 5, 5, 5, 20, 5]
    assert sum(s['timeout-minutes'] for s in setup) == 45

    finalization = [
        named('disk after build'),
        named('label diagnostic output and make guest harness output readable'),
        named('upload browser evidence'),
        named('upload diagnostics'),
    ]
    assert [s['timeout-minutes'] for s in finalization] == [5, 10, 10, 10]
    assert sum(s['timeout-minutes'] for s in finalization) == 35
    # The always-run ci-cleanup step is the last step of the job and takes 3 of the
    # 5 minutes that used to be unallocated margin.
    cleanup = steps[-1]
    assert cleanup['name'].startswith('cleanup (') and cleanup['if'] == 'always()'
    assert cleanup['timeout-minutes'] == 3
    assert 360 - 275 - 45 - 35 - cleanup['timeout-minutes'] == 2


def test_diagnostic_receipt_finalizer_runs_before_upload_and_skips_qualification_upload():
    steps = WORKFLOW['jobs']['full-matrix']['steps']
    names = [s.get('name', '') for s in steps]
    finalizer = next(s for s in steps if s.get('name') == 'label diagnostic output and make guest harness output readable')
    diagnostics = next(s for s in steps if s.get('name') == 'upload diagnostics')
    browser_evidence = next(s for s in steps if s.get('name') == 'upload browser evidence (survives guest failure)')
    validate = next(s for s in steps if s.get('name') == 'validate + merge qualification evidence')
    upload_qualification = next(s for s in steps if s.get('name') == 'upload qualification evidence')

    assert finalizer['if'] == 'always()'
    assert finalizer['env']['STRICT_ROUNDTRIP_TEST'] == "${{ github.event.inputs.strict_roundtrip_test }}"
    assert finalizer['run'].strip() == 'just full-label-output'
    label = recipe('full-label-output')
    assert 'finalize-diagnostic-output.py' in label
    assert label.index('finalize-diagnostic-output.py') < label.index('sudo chown -R')
    assert names.index(finalizer['name']) < names.index(diagnostics['name'])
    assert 'luks-verify-*/' in diagnostics['with']['path']
    assert names.index(finalizer['name']) < names.index(browser_evidence['name'])
    assert "strict_roundtrip_test != 'true'" in validate['if']
    assert "strict_roundtrip_test != 'true'" in upload_qualification['if']


@pytest.mark.parametrize("field,value", [
    ("run_attempt", 2), ("head_sha", "0" * 40), ("status", "in_progress"),
])
def test_recovery_refuses_changed_producer_before_fetch(tmp_path, monkeypatch, field, value):
    run_doc = {
        "id": 41153841817, "run_attempt": 1,
        "head_sha": "41cf974098ef5a90c9a73fd3942ed0abeb0c8058",
        "path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "failure",
    }
    run_doc[field] = value
    calls = []

    def api(command, **kwargs):
        calls.append(command[-1])
        return json.dumps(run_doc)

    monkeypatch.setattr(m.subprocess, "check_output", api)
    with pytest.raises(SystemExit, match="producer run identity"):
        m.main(["recover", "--dir", str(tmp_path / "chunks"),
                "--evidence-dir", str(tmp_path / "evidence")])
    assert calls == ["repos/tuna-os/iso-builder/actions/runs/41153841817"]
    assert not (tmp_path / "chunks").exists()


@pytest.mark.parametrize("tamper", ["expired", "digest", "source", "archive"])
def test_recovery_rejects_artifact_metadata_or_download_corruption(tmp_path, monkeypatch, tamper):
    sha = "41cf974098ef5a90c9a73fd3942ed0abeb0c8058"
    run_doc = {"id": 41153841817, "run_attempt": 1, "head_sha": sha,
               "path": ".github/workflows/ci.yml", "status": "completed", "conclusion": "failure"}
    artifact = {
        "id": 13027183695, "name": "iso-skipjack-gnome-run41153841817-a1",
        "digest": "sha256:057c98786f98d78eaa03edee9c9db48a54499f3a146940a4ffcb4deea79ff04b",
        "size_in_bytes": 11452406380, "expired": False,
        "workflow_run": {"id": 41153841817, "head_sha": sha, "repository_id": 1305022978},
    }
    if tamper == "expired":
        artifact["expired"] = True
    elif tamper == "digest":
        artifact["digest"] = digest(b"other")
    elif tamper == "source":
        artifact["workflow_run"]["head_sha"] = "0" * 40
    downloads = []

    def api(command, **kwargs):
        return json.dumps(run_doc if "/runs/" in command[-1] else artifact)

    def download(command, *, stdout, check):
        downloads.append(command[-1])
        stdout.write(b"corrupt archive")

    monkeypatch.setattr(m.subprocess, "check_output", api)
    monkeypatch.setattr(m.subprocess, "run", download)
    with pytest.raises(SystemExit, match="archive bytes" if tamper == "archive" else "artifact identity"):
        m.main(["recover", "--dir", str(tmp_path / "chunks"),
                "--evidence-dir", str(tmp_path / "evidence")])
    assert len(downloads) == (1 if tamper == "archive" else 0)
    assert not (tmp_path / "chunks/manifest.json").exists()
    assert not (tmp_path / "evidence").exists()
