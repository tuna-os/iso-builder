"""Synthetic local file/context tests; no browser, upload or boot claims."""
import importlib.util
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location('provenance', Path(__file__).parents[1] / 'scripts/collect-candidate-provenance.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


@pytest.fixture
def candidate(tmp_path):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(tmp_path), *args], text=True).strip()
    git('init', '-q')
    for name in ('app/public/index.html', 'app/public/app.js', '.github/workflows/ci.yml'):
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('synthetic fixture only\n')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
    for name in m.GENERATED:
        (tmp_path / name).write_bytes(b'synthetic not bootable')
    head = git('rev-parse', 'HEAD')
    env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REPOSITORY=m.REPOSITORY,
               GITHUB_SHA=head, GITHUB_WORKFLOW_SHA=head, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1',
               GITHUB_JOB='full-matrix', GITHUB_WORKFLOW_REF=m.REPOSITORY + '/.github/workflows/ci.yml@refs/heads/fixture')
    iso = tmp_path / 'candidate.iso'
    iso.write_bytes(b'synthetic not bootable iso')
    ev = dict(kind='diagnostic-build-measurements', qualification='not-assessed',
              iso=m.digest_file(iso),
              loadedWasm=m.digest_file(tmp_path / 'app/public/tbox.wasm'))
    return tmp_path, ev, env, iso


def test_context_is_never_authenticated_or_qualified(candidate):
    result = m.collect(*candidate)
    assert result['qualification'] == 'not-assessed'
    assert result['producerContext']['authentication'] == 'not-verified'
    assert result['servedTree']['browserDelivery'] == 'not-verified'
    assert result['artifactBinding'] == 'not-verified'
    assert len(result['missingIdentity']) == 3
    assert 'receiptDigest' not in result
    assert len(result['servedTree']['files']) == 5


@pytest.mark.parametrize('key,value', [('GITHUB_ACTIONS', 'false'), ('GITHUB_EVENT_NAME', 'pull_request'),
    ('GITHUB_REPOSITORY', 'attacker/iso-builder'), ('GITHUB_SHA', '0' * 40), ('GITHUB_WORKFLOW_SHA', '0' * 40),
    ('GITHUB_RUN_ID', '-1'), ('GITHUB_RUN_ATTEMPT', '0'), ('GITHUB_JOB', 'deploy'),
    ('GITHUB_WORKFLOW_REF', 'tuna-os/iso-builder/.github/workflows/other.yml@refs/heads/main')])
def test_bad_context_rejected(candidate, key, value):
    root, ev, env, iso = candidate
    env[key] = value
    with pytest.raises(ValueError):
        m.collect(root, ev, env, iso)


def test_wasm_mismatch(candidate):
    root, ev, env, iso = candidate
    (root / 'app/public/tbox.wasm').write_bytes(b'other bytes')
    with pytest.raises(ValueError, match='WASM'):
        m.collect(root, ev, env, iso)


@pytest.mark.parametrize('which', ['app/public/app.js', '.github/workflows/ci.yml'])
def test_dirty_served_checkout_rejected(candidate, which):
    root, ev, env, iso = candidate
    (root / which).write_text('different')
    with pytest.raises(ValueError, match='differs'):
        m.collect(root, ev, env, iso)


def test_unknown_served_file_rejected(candidate):
    root, ev, env, iso = candidate
    (root / 'app/public/surprise.js').write_text('unknown')
    with pytest.raises(ValueError, match='untracked'):
        m.collect(root, ev, env, iso)


def test_symlink_generated_asset_rejected(candidate):
    root, ev, env, iso = candidate
    p = root / 'app/public/wasm_exec.js'
    p.unlink()
    p.symlink_to(root / 'app/public/app.js')
    with pytest.raises(ValueError, match='symlink'):
        m.collect(root, ev, env, iso)


@pytest.mark.parametrize('field,value', [('sha256', 'main'), ('sizeBytes', True), ('sizeBytes', 0)])
def test_bad_iso_measurement(candidate, field, value):
    root, ev, env, iso = candidate
    ev['iso'][field] = value
    with pytest.raises(ValueError, match='iso'):
        m.collect(root, ev, env, iso)


def test_same_size_iso_mutation_rejected(candidate):
    root, ev, env, iso = candidate
    iso.write_bytes(b'x' * iso.stat().st_size)
    with pytest.raises(ValueError, match='candidate ISO'):
        m.collect(root, ev, env, iso)


def test_caller_qualification_claim_rejected(candidate):
    root, ev, env, iso = candidate
    ev['qualification'] = 'qualified'
    with pytest.raises(ValueError, match='unqualified'):
        m.collect(root, ev, env, iso)


@pytest.mark.parametrize('flag', ['--assume-unchanged', '--skip-worktree'])
def test_index_flags_cannot_hide_frontend_mutation(candidate, flag):
    root, ev, env, iso = candidate
    subprocess.check_call(['git', '-C', str(root), 'update-index', flag, 'app/public/app.js'])
    (root / 'app/public/app.js').write_text('changed but hidden from git diff')
    with pytest.raises(ValueError, match='committed'):
        m.collect(root, ev, env, iso)


def test_replace_ref_cannot_substitute_reviewed_commit(candidate):
    root, ev, env, iso = candidate
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    original = env['GITHUB_SHA']
    (root / 'app/public/app.js').write_text('unreviewed replacement')
    git('add', 'app/public/app.js')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'replacement')
    replacement = git('rev-parse', 'HEAD')
    git('update-ref', 'HEAD', original)
    git('replace', original, replacement)
    with pytest.raises(ValueError):
        m.collect(root, ev, env, iso)


def test_index_and_external_diff_cannot_hide_missing_asset(candidate):
    root, ev, env, iso = candidate
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    extra = root / 'app/public/additional.js'
    extra.write_text('additional required asset')
    git('add', 'app/public/additional.js')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'additional asset')
    env['GITHUB_SHA'] = env['GITHUB_WORKFLOW_SHA'] = git('rev-parse', 'HEAD')
    git('update-index', '--force-remove', 'app/public/additional.js')
    extra.unlink()
    git('config', 'diff.external', 'true')
    with pytest.raises(ValueError):
        m.collect(root, ev, env, iso)


def test_loaded_frontend_join_stays_diagnostic(candidate):
    root, ev, env, iso = candidate
    for name in ('layercache.js', 'build-result.js'):
        (root / 'app/public' / name).write_text('synthetic frontend fixture')
    subprocess.check_call(['git', '-C', str(root), 'add', '.'])
    subprocess.check_call(['git', '-C', str(root), '-c', 'user.name=Fixture',
                           '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'scripts'])
    env['GITHUB_SHA'] = env['GITHUB_WORKFLOW_SHA'] = m.git(root, 'rev-parse', 'HEAD')
    origin = 'http://127.0.0.1:8931'
    ev['loadedFrontend'] = {
        'schemaVersion': 1, 'kind': 'diagnostic-loaded-frontend',
        'qualification': 'not-assessed', 'authentication': 'not-verified',
        'coverage': 'page-target-only',
        'origin': origin, 'documentURL': origin + '/', 'assets': [
            {**m.digest_file(root / 'app/public' / name),
             'url': origin + ('/' if name == 'index.html' else '/' + name),
             'resourceType': 'document' if name == 'index.html' else 'wasm' if name == 'tbox.wasm' else 'script',
             'responseCount': 1} for name in sorted(m.FRONTEND_REQUIRED)],
    }
    result = m.collect(root, ev, env, iso)
    assert result['loadedFrontendBinding']['status'] == 'observed-bytes-match-served-tree'
    assert result['producerContext']['authentication'] == 'not-verified'
    assert result['qualification'] == 'not-assessed'
    assert result['artifactBinding'] == 'not-verified'
    assert 'authenticated-producer' in result['missingIdentity']
    ev['loadedFrontend']['assets'][0]['sha256'] = 'sha256:' + 'f' * 64
    with pytest.raises(ValueError, match='served bytes'):
        m.collect(root, ev, env, iso)
