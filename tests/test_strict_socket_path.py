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
import tempfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNNER_WORKSPACE = '/home/runner/work/iso-builder/iso-builder'
needs_just = pytest.mark.skipif(shutil.which('just') is None, reason='just not installed')


def longest_slug():
    data = json.loads((ROOT / 'e2e/editions.json').read_text())
    editions = data if isinstance(data, list) else data['editions']
    return max((e['slug'] for e in editions), key=len)


def run_strict(tmp_path, workdir, slug):
    harness = tmp_path / 'ws/tunaos-e2e-current/scripts/iso-e2e.sh'
    harness.parent.mkdir(parents=True)
    ran = tmp_path / 'harness-ran'
    harness.write_text(f'#!/bin/sh\ntouch {ran}\n')
    harness.chmod(0o755)
    bindir = tmp_path / 'bin'
    bindir.mkdir()
    sudo = bindir / 'sudo'
    sudo.write_text('#!/bin/sh\ncase "$1" in\n'
                    '  tee) cat >/dev/null ;;\n'
                    '  udevadm) exit 0 ;;\n'
                    '  *) exec "$@" ;;\n'
                    'esac\n')
    sudo.chmod(0o755)
    media = tmp_path / 'media'
    media.mkdir()
    (media / f'{slug}-roundtrip.iso').write_bytes(b'fixture')
    env = {**os.environ, 'SLUG': slug, 'RUNNER_TEMP': str(media),
           'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
           'GITHUB_WORKSPACE': str(tmp_path / 'ws'), 'GITHUB_STEP_SUMMARY': str(tmp_path / 'summary'),
           'VARIANT': 'skipjack', 'FLAVOR': 'gnome', 'STRICT_PUBLISHED_MEDIA': '1'}
    for key in ('EXECUTION_KIND', 'SOURCE_DIGEST', 'SOURCE_REF', 'OVERLAY_DIGEST',
                'INSTALLER_DIGEST', 'ENGINE_DIGEST', 'MEDIA_DIGEST', 'PLATFORM',
                'CPU_BASELINE', 'HARDWARE_SCOPE', 'BROWSER_NAME', 'BROWSER_VERSION',
                'BROWSER_MEMORY_GIB', 'BROWSER_FREE_DISK_GIB'):
        env[f'TUNAOS_QUAL_{key}'] = 'fixture'
    env.pop('STRICT_INSTALL_MODE', None)
    env.pop('DIAGNOSTIC_UNQUALIFIED', None)
    r = subprocess.run(['just', '--justfile', str(ROOT / 'justfile'), '--working-directory', str(workdir),
                        'full-guest-verify-strict'], env=env, text=True, capture_output=True)
    return r, ran


@needs_just
def test_too_long_output_dir_fails_before_the_harness_runs(tmp_path):
    r, ran = run_strict(tmp_path, tmp_path, 'x' * 80)
    assert r.returncode != 0
    assert not ran.exists()


@needs_just
def test_short_output_dir_reaches_the_harness_with_local_defaults(tmp_path):
    with tempfile.TemporaryDirectory(prefix='strict-') as workdir:
        r, ran = run_strict(tmp_path, Path(workdir), 'skipjack-gnome')
    assert r.returncode == 0, r.stdout + r.stderr
    assert ran.exists()


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
        r, ran = run_strict(tmp_path, workdir, longest_slug())
    finally:
        if made:
            workdir.rmdir()
    assert r.returncode == 0, r.stdout + r.stderr
    assert ran.exists()
