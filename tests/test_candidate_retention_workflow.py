"""Execute dispatch plan with tiny local config; never dispatch a workflow."""
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())


def plan(env):
    pick = next(s for s in WORKFLOW['jobs']['full-plan']['steps'] if s.get('id') == 'pick')
    assert pick['run'].strip() == 'just --quiet full-plan >> "$GITHUB_OUTPUT"'
    return subprocess.run([sys.executable, 'scripts/plan-full-matrix.py'], cwd=ROOT, env={**os.environ, **env}, text=True, capture_output=True)


def valid():
    return dict(RETAIN_CANDIDATE='true', RUN_FULL='true', ONLY='yellowfin-gnome', BENCHMARK='false', KEEP_ISO='false')


def test_only_approved_single_cell():
    result = plan(valid())
    assert result.returncode == 0, result.stderr
    assert 'count=1' in result.stdout
    assert '"slug": "yellowfin-gnome"' in result.stdout


@pytest.mark.parametrize('key,value', [('ONLY', ''), ('ONLY', 'bonito-kde'), ('ONLY', 'yellowfin-gnome,bonito-kde'),
    ('ONLY', ' yellowfin-gnome '), ('RUN_FULL', 'false'), ('BENCHMARK', 'true'), ('KEEP_ISO', 'true')])
def test_scope_fails_plan_before_any_build(key, value):
    env = valid()
    env[key] = value
    result = plan(env)
    assert result.returncode != 0
    assert 'candidate retention requires' in result.stderr


def test_retention_preserves_guest_failure_and_explicit_limits():
    job = WORKFLOW['jobs']['full-matrix']
    retain = next(s for s in job['steps'] if s.get('name', '').startswith('retain opt-in'))
    assert 'always()' in retain['if'] and '!cancelled()' in retain['if']
    assert "steps.browser-build.outcome == 'success'" in retain['if']
    assert 'continue-on-error' not in retain
    assert retain['timeout-minutes'] == 20
    assert 'No automatic expiry' in retain['run']
    assert 'retain-browser-candidate.py' in retain['run']
    assert 'rclone' not in retain['run']
    preflight = next(s for s in job['steps'] if s.get('name', '').startswith('preflight opt-in'))
    build = next(s for s in job['steps'] if s.get('id') == 'browser-build')
    assert job['steps'].index(preflight) < job['steps'].index(build)
    assert 'IfNoneMatch' in preflight['run']
    assert preflight['timeout-minutes'] == 5
    assert WORKFLOW['permissions'] == {'contents': 'read'}
