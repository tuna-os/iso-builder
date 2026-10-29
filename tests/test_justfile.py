"""The justfile parses, every recipe a workflow calls exists, and the moved scripts behave."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[1]
needs_just = pytest.mark.skipif(shutil.which('just') is None, reason='just not installed')


def workflow_recipes():
    """Every `just <recipe>` a workflow step runs, with the step that runs it."""
    found = []
    for wf_path in (ROOT / '.github/workflows').glob('*.yml'):
        wf = yaml.safe_load(wf_path.read_text())
        for job_name, job in (wf.get('jobs') or {}).items():
            for step in job.get('steps', []):
                for line in step.get('run', '').splitlines():
                    m = re.match(r'(?:.*&&\s*)?just\s+(?:--quiet\s+)?([a-z][a-z0-9-]*)\b', line.strip())
                    if m:
                        found.append((wf_path.name, job_name, m.group(1)))
    return found


def test_workflows_call_recipes():
    names = {recipe for _, _, recipe in workflow_recipes()}
    assert {'ci-cleanup', 'ci-reap-stale', 'full-build', 'full-guest-verify', 'e2e-gate', 'wasm-build'} <= names


@needs_just
def test_just_lists_and_parses():
    r = subprocess.run(['just', '--list'], cwd=ROOT, text=True, capture_output=True)
    assert r.returncode == 0, r.stderr
    for name in ('ci-cleanup', 'ci-reap-stale', 'full-build', 'e2e-gate', 'wasm-build'):
        assert name in r.stdout


@needs_just
@pytest.mark.parametrize('recipe', sorted({r for _, _, r in workflow_recipes()}))
def test_every_recipe_a_workflow_calls_dry_runs(recipe):
    r = subprocess.run(['just', '--dry-run', recipe], cwd=ROOT, text=True, capture_output=True)
    assert r.returncode == 0, r.stderr


@needs_just
def test_wasm_pin_recipe_keeps_its_go_template_braces():
    r = subprocess.run(['just', '--dry-run', 'wasm-resolve-pin'], cwd=ROOT, text=True, capture_output=True)
    assert "'{{.Version}}'" in r.stderr + r.stdout


def test_every_recipe_is_shell_syntax_clean():
    r = subprocess.run(['just', '--dump', '--dump-format', 'json'], cwd=ROOT, text=True, capture_output=True) \
        if shutil.which('just') else None
    if r is None:
        pytest.skip('just not installed')
    assert r.returncode == 0, r.stderr
    for name, recipe in json.loads(r.stdout)['recipes'].items():
        body = '\n'.join(''.join(part if isinstance(part, str) else '{{x}}' for part in line) for line in recipe['body'])
        if recipe['body'] and body.startswith('#!/usr/bin/env bash'):
            check = subprocess.run(['bash', '-n'], input=body, text=True, capture_output=True)
            assert check.returncode == 0, f'{name}: {check.stderr}'


def test_steps_that_hold_secrets_stay_in_the_workflow():
    """Publishing/retention steps with R2 credentials are deliberately not recipes."""
    wf = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
    for step in wf['jobs']['full-matrix']['steps']:
        if 'secrets.' in yaml.safe_dump(step.get('env', {})):
            assert 'just ' not in step['run'], step['name']


# --- scripts/validate-qualification-evidence.py (moved verbatim from ci.yml) --------------

def evidence(**over):
    ev = {'schemaVersion': 1, 'kind': 'qualification-evidence', 'half': 'browser', 'browser': {'name': 'chromium'},
          'target': {'image': 'tuna-os/x'}, 'run': {'sample': 1},
          'phasesMs': {'inspect': 10, 'build': 20, 'save': 30},
          'resources': {'isoBytes': 1000, 'peakTboxWasmMB': 5, 'peakTboxJsHeapMB': 6}}
    ev.update(over)
    return ev


def validate(tmp_path, files, **env):
    results = tmp_path / 'test-results'
    results.mkdir(exist_ok=True)
    for name, doc in files.items():
        (results / name).write_text(json.dumps(doc))
    return subprocess.run([sys.executable, str(ROOT / 'scripts/validate-qualification-evidence.py')], cwd=tmp_path,
                          env={**os.environ, 'SLUG': 'x', 'BENCHMARK': 'false', **env}, text=True, capture_output=True)


def test_validates_a_single_sample(tmp_path):
    r = validate(tmp_path, {'qual-evidence-x-s1.json': evidence()})
    assert r.returncode == 0, r.stderr
    assert 'validated 1 browser evidence file(s)' in r.stdout
    assert not (tmp_path / 'test-results/qual-evidence-x-benchmark.json').exists()


def test_missing_or_invalid_evidence_fails(tmp_path):
    assert 'no browser evidence for x' in validate(tmp_path, {}).stderr
    bad = evidence()
    del bad['resources']
    r = validate(tmp_path, {'qual-evidence-x-s1.json': bad})
    assert r.returncode != 0 and 'invalid QualificationEvidence v1' in r.stderr


def test_benchmark_merges_three_samples_into_median_and_range(tmp_path):
    files = {f'qual-evidence-x-s{i}.json': evidence(phasesMs={'inspect': 10 * i, 'build': 20, 'save': 30}) for i in (1, 2, 3)}
    r = validate(tmp_path, files, BENCHMARK='true')
    assert r.returncode == 0, r.stderr
    merged = json.loads((tmp_path / 'test-results/qual-evidence-x-benchmark.json').read_text())
    assert merged['half'] == 'browser-benchmark' and len(merged['samples']) == 3
    assert merged['summary']['phasesMs.inspect'] == {'samples': [10, 20, 30], 'median': 20, 'range': 20}


def test_benchmark_needs_exactly_three_samples(tmp_path):
    r = validate(tmp_path, {'qual-evidence-x-s1.json': evidence()}, BENCHMARK='true')
    assert r.returncode != 0 and 'benchmark mode needs 3 samples' in r.stderr
