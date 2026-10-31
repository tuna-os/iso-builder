"""The strict harness binds Unix sockets under its output dir; sun_path holds 107 bytes.

Run 41141898527 failed because `luks-verify-<slug>-same-byte-diagnostic-unqualified`
pushed strict-plain-warm-serial.sock to 131 bytes. The recipe now uses a short
directory and refuses to start the harness when the longest socket would not fit.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from ci_sources import recipe

ROOT = Path(__file__).resolve().parents[1]
RUNNER_WORKSPACE = '/home/runner/work/iso-builder/iso-builder'
LONGEST_SOCKET = 'strict-plain-warm-serial.sock'
needs_just = pytest.mark.skipif(shutil.which('just') is None, reason='just not installed')


def longest_slug():
    data = json.loads((ROOT / 'e2e/editions.json').read_text())
    editions = data if isinstance(data, list) else data['editions']
    return max((e['slug'] for e in editions), key=len)


def test_recipe_and_label_step_share_the_short_output_dir():
    strict = recipe('full-guest-verify-strict')
    assert 'OUT="luks-verify-${SLUG}-diag"' in strict
    assert '--output "$OUT"' in strict
    assert '"luks-verify-${SLUG}-diag"' in recipe('full-label-output')


def test_longest_catalog_socket_fits_on_the_hosted_runner():
    path = f'{RUNNER_WORKSPACE}/luks-verify-{longest_slug()}-diag/{LONGEST_SOCKET}'
    assert len(path) <= 107, (len(path), path)


def run_strict(tmp_path, workdir, slug):
    harness = tmp_path / 'ws/tunaos-e2e-current/scripts/iso-e2e.sh'
    harness.parent.mkdir(parents=True)
    ran = tmp_path / 'harness-ran'
    harness.write_text(f'#!/bin/sh\ntouch {ran}\n')
    harness.chmod(0o755)
    env = {**os.environ, 'SLUG': slug, 'RUNNER_TEMP': str(tmp_path / 'no-iso'),
           'GITHUB_WORKSPACE': str(tmp_path / 'ws'), 'GITHUB_STEP_SUMMARY': str(tmp_path / 'summary')}
    r = subprocess.run(['just', '--justfile', str(ROOT / 'justfile'), '--working-directory', str(workdir),
                        'full-guest-verify-strict'], env=env, text=True, capture_output=True)
    return r, ran


@needs_just
def test_too_long_output_dir_fails_before_the_harness_runs(tmp_path):
    r, ran = run_strict(tmp_path, tmp_path, 'x' * 80)
    assert r.returncode != 0
    assert 'over the 107-byte sun_path limit' in r.stdout + r.stderr
    assert not ran.exists()


@needs_just
def test_runner_length_workspace_with_longest_slug_passes_the_guard(tmp_path):
    # A workspace exactly as long as the hosted runner's: the checkout itself
    # on the runner, otherwise a padded directory inside a shorter checkout.
    pad = len(RUNNER_WORKSPACE) - len(str(ROOT)) - 1
    if pad == -1:
        workdir, made = ROOT, False
    elif pad >= 1:
        workdir, made = ROOT / ('w' * pad), True
    else:
        pytest.skip('checkout path cannot be shaped to the hosted runner workspace length')
    assert len(str(workdir)) == len(RUNNER_WORKSPACE)
    if made:
        workdir.mkdir(exist_ok=True)
    try:
        r, _ = run_strict(tmp_path, workdir, longest_slug())
    finally:
        if made:
            workdir.rmdir()
    out = r.stdout + r.stderr
    assert 'sun_path' not in out
    # Past the guard, the next check is the missing ISO.
    assert 'Verified round-trip ISO is missing' in out
