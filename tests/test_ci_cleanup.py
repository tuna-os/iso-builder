"""scripts/ci-cleanup.py: removes only what the job owns. Temp dirs, real processes."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest
import yaml

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('ci_cleanup', ROOT / 'scripts/ci-cleanup.py')
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

needs_proc = pytest.mark.skipif(not Path('/proc/self/cmdline').exists(), reason='needs /proc')


def touch(path, data=b'x' * 16):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def job(tmp_path):
    temp = tmp_path / 'runner-temp'
    ws = tmp_path / 'workspace'
    temp.mkdir()
    ws.mkdir()
    env = {'RUNNER_TEMP': str(temp), 'GITHUB_WORKSPACE': str(ws), 'GITHUB_RUN_ID': '777',
           'GITHUB_RUN_ATTEMPT': '2', 'SLUG': 'yellowfin-gnome', 'HOME': str(tmp_path / 'home'),
           'CI_CLEANUP_KILL_GRACE': '1'}
    owned = [
        touch(temp / 'yellowfin-gnome.iso'),
        touch(temp / 'yellowfin-gnome-roundtrip.iso'),
        touch(temp / 'yellowfin-gnome-s1.iso'),
        touch(temp / 'yellowfin-gnome-s3.iso'),
        touch(temp / 'iso-artifact/manifest.json'),
        touch(temp / 'iso-roundtrip/chunk-0'),
        touch(temp / 'iso-roundtrip-result.json'),
        touch(temp / 'candidate-retention-venv/bin/python'),
        touch(temp / 'pw-profile-777-2/tmp/pw-prof-0/Default/Cache'),
        touch(ws / 'luks-verify-yellowfin-gnome/disk.qcow2', b'q' * 4096),
        touch(ws / 'luks-verify-yellowfin-gnome/swtpm/swtpm.pid'),
        touch(ws / 'luks-verify-yellowfin-gnome-diag/serial.log'),
        touch(ws / 'luks-verify-yellowfin-gnome-diag/disk.qcow2', b'q' * 4096),
        touch(ws / 'luks-verify-yellowfin-gnome-diag/swtpm/swtpm.pid'),
        touch(ws / 'luks-verify-yellowfin-gnome-diag/vsock-ssh-key'),
        touch(ws / 'e2e/test-results/qual-evidence.json'),
        touch(ws / 'e2e/playwright-report/index.html'),
        touch(ws / 'e2e/iso-builder-e2e-output.iso'),
    ]
    kept = [
        touch(temp / 'bonito-kde.iso'),                    # another cell's ISO
        touch(temp / 'yellowfin-gnome-sx.iso'),            # not a sample number
        touch(temp / 'yellowfin-gnome-extra.iso'),
        touch(temp / 'xyellowfin-gnome.iso'),
        touch(temp / 'pw-profile-777-1/Default/Cache'),    # another attempt
        touch(temp / 'pw-profile-778-2/Default/Cache'),    # another run
        touch(temp / '_runner_file_commands/save_state'),  # the runner's own state
        touch(ws / 'luks-verify-bonito-kde/disk.qcow2'),
        touch(ws / 'luks-verify-yellowfin-gnome-2/disk.qcow2'),
        touch(ws / 'luks-verify-yellowfin-gnome-diag-other/disk.qcow2'),
        touch(ws / 'e2e/package.json'),
        touch(ws / 'e2e/tests/builder.spec.js'),
        touch(ws / 'justfile'),
    ]
    return env, owned, kept


def test_removes_everything_it_owns_and_nothing_else(job, capsys):
    env, owned, kept = job
    assert cc.main(env) == 0
    assert [p for p in owned if os.path.lexists(p)] == []
    assert [p for p in kept if not p.exists()] == []
    assert 'freed' in capsys.readouterr().out


def test_idempotent_and_safe_when_nothing_exists(job, tmp_path):
    env, *_ = job
    assert cc.main(env) == 0
    assert cc.main(env) == 0
    empty = dict(env, RUNNER_TEMP=str(tmp_path / 'never-created'), GITHUB_WORKSPACE=str(tmp_path / 'also-never'))
    assert cc.main(empty) == 0


def test_dry_run_prints_and_deletes_nothing(job, capsys):
    env, owned, _ = job
    assert cc.main(dict(env, DRY_RUN='1')) == 0
    assert all(p.exists() for p in owned)
    out = capsys.readouterr().out
    assert 'would remove' in out and 'yellowfin-gnome.iso' in out


def test_outside_a_ci_run_it_owns_nothing(job):
    env, owned, kept = job
    env = {k: v for k, v in env.items() if k != 'GITHUB_RUN_ID'}
    assert cc.main(env) == 0
    assert all(p.exists() for p in owned + kept)


def test_slug_list_cleans_each_cell(job):
    env, owned, kept = job
    other = touch(Path(env['RUNNER_TEMP']) / 'bonito-kde.iso')
    assert cc.main(dict(env, SLUG='yellowfin-gnome, bonito-kde')) == 0
    assert not other.exists()
    assert not (Path(env['GITHUB_WORKSPACE']) / 'luks-verify-bonito-kde').exists()
    assert (Path(env['GITHUB_WORKSPACE']) / 'luks-verify-yellowfin-gnome-2/disk.qcow2').exists()
    assert (Path(env['RUNNER_TEMP']) / 'yellowfin-gnome-extra.iso').exists()


@pytest.mark.parametrize('slug', ['../outside', 'a/b', '-rf', '.', '..', 'x y/z', '$(id)'])
def test_unsafe_slug_is_refused_before_anything_is_removed(job, slug):
    env, owned, kept = job
    assert cc.main(dict(env, SLUG=slug)) == 1
    assert all(p.exists() for p in owned + kept)


@pytest.mark.parametrize('key', ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
@pytest.mark.parametrize('bad', ['abc', '1; rm -rf /', '../1'])
def test_non_numeric_run_identity_is_refused(job, key, bad):
    env, owned, kept = job
    assert cc.main(dict(env, **{key: bad})) == 1
    assert all(p.exists() for p in owned + kept)


def test_refuses_filesystem_root_and_home_as_a_root(job, tmp_path):
    env, owned, kept = job
    assert cc.main(dict(env, RUNNER_TEMP='/')) == 1
    assert cc.main(dict(env, GITHUB_WORKSPACE='/')) == 1
    home = tmp_path / 'home'
    home.mkdir()
    assert cc.main(dict(env, RUNNER_TEMP=str(home), HOME=str(home))) == 1
    assert all(p.exists() for p in owned + kept)


def test_symlinked_iso_is_unlinked_but_never_followed(job, tmp_path):
    env, owned, kept = job
    secret = touch(tmp_path / 'elsewhere/precious.iso')
    link = Path(env['RUNNER_TEMP']) / 'yellowfin-gnome.iso'
    link.unlink()
    link.symlink_to(secret)
    dir_target = tmp_path / 'elsewhere/dir'
    touch(dir_target / 'keep.txt')
    dir_link = Path(env['RUNNER_TEMP']) / 'iso-artifact'
    shutil.rmtree(dir_link)
    dir_link.symlink_to(dir_target, target_is_directory=True)
    assert cc.main(env) == 0
    assert not os.path.lexists(link) and not os.path.lexists(dir_link)
    assert secret.exists() and (dir_target / 'keep.txt').exists()


def test_a_workspace_directory_that_escapes_through_a_symlink_is_refused(job, tmp_path):
    env, owned, kept = job
    outside = tmp_path / 'outside'
    touch(outside / 'test-results/precious.json')
    ws = Path(env['GITHUB_WORKSPACE'])
    shutil.rmtree(ws / 'e2e')
    (ws / 'e2e').symlink_to(outside, target_is_directory=True)
    assert cc.main(env) == 1
    assert (outside / 'test-results/precious.json').exists()


def spawn(*marker_args):
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)', *map(str, marker_args)])
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:  # wait for exec so /proc shows the final argv
        if str(marker_args[0]) in Path(f'/proc/{proc.pid}/cmdline').read_text():
            break
        time.sleep(0.02)
    return proc


@needs_proc
def test_stops_processes_started_against_this_jobs_paths_only(job):
    env, owned, kept = job
    ws = Path(env['GITHUB_WORKSPACE'])
    temp = Path(env['RUNNER_TEMP'])
    qemu = spawn(f"-pidfile={ws / 'luks-verify-yellowfin-gnome/qemu.pid'}")
    swtpm = spawn('--tpmstate', f"dir={ws / 'luks-verify-yellowfin-gnome/swtpm'}")
    chromium = spawn(f"--user-data-dir={temp / 'pw-profile-777-2/tmp/pw-prof-0'}")
    diag_qemu = spawn(f"-pidfile={ws / 'luks-verify-yellowfin-gnome-diag/qemu.pid'}")
    diag_swtpm = spawn('--tpmstate', f"dir={ws / 'luks-verify-yellowfin-gnome-diag/swtpm'}")
    diag_sibling = spawn(f"-pidfile={ws / 'luks-verify-yellowfin-gnome-diag-other/qemu.pid'}")
    other_cell = spawn(f"-pidfile={ws / 'luks-verify-bonito-kde/qemu.pid'}")
    prefix_sibling = spawn(f"-pidfile={ws / 'luks-verify-yellowfin-gnome-2/qemu.pid'}")
    other_run = spawn(f"--user-data-dir={temp / 'pw-profile-778-2/tmp/pw-prof-0'}")
    bystander = spawn('/usr/bin/unrelated')
    try:
        assert cc.main(env) == 0
        for p in (qemu, swtpm, chromium, diag_qemu, diag_swtpm):
            assert p.wait(timeout=10) is not None, 'owned process must be stopped'
        for p in (other_cell, prefix_sibling, other_run, bystander, diag_sibling):
            assert p.poll() is None, 'unowned process must keep running'
    finally:
        for p in (qemu, swtpm, chromium, diag_qemu, diag_swtpm, diag_sibling,
                  other_cell, prefix_sibling, other_run, bystander):
            p.kill()
            p.wait()


@needs_proc
def test_dry_run_leaves_processes_running(job):
    env, *_ = job
    ws = Path(env['GITHUB_WORKSPACE'])
    qemu = spawn(f"-pidfile={ws / 'luks-verify-yellowfin-gnome/qemu.pid'}")
    try:
        assert cc.main(dict(env, DRY_RUN='1')) == 0
        assert qemu.poll() is None
    finally:
        qemu.kill()
        qemu.wait()


@needs_proc
def test_process_that_ignores_sigterm_is_killed_after_the_grace_period(job):
    env, *_ = job
    ws = Path(env['GITHUB_WORKSPACE'])
    marker = ws / 'luks-verify-yellowfin-gnome/qemu.pid'
    code = 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'
    proc = subprocess.Popen([sys.executable, '-c', code, str(marker)])
    time.sleep(0.3)
    try:
        assert cc.main(env) == 0
        assert proc.wait(timeout=10) == -9
    finally:
        proc.kill()
        proc.wait()


# --- just recipe wiring ------------------------------------------------------

needs_just = pytest.mark.skipif(shutil.which('just') is None, reason='just not installed')


@needs_just
def test_recipe_runs_the_script_end_to_end(job):
    env, owned, kept = job
    r = subprocess.run(['just', 'ci-cleanup'], cwd=ROOT, env={**os.environ, **env}, text=True, capture_output=True)
    assert r.returncode == 0, r.stderr
    assert [p for p in owned if os.path.lexists(p)] == []
    assert all(p.exists() for p in kept)


@needs_just
def test_browser_profile_root_the_recipes_choose_is_the_one_cleanup_owns(job, tmp_path):
    """e2e-gate/full-build point Playwright at pw-profile-<run>-<attempt>; ci-cleanup must own exactly that."""
    env, *_ = job
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    record = tmp_path / 'profile-root.txt'
    fake_npx = bin_dir / 'npx'
    fake_npx.write_text(f'#!/bin/sh\nprintf %s "$TBOX_E2E_PROFILE_ROOT" > {record}\n')
    fake_npx.chmod(0o755)
    run_env = {**os.environ, **env, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'SLUG': 'yellowfin-gnome'}
    run_env.pop('TBOX_E2E_PROFILE_ROOT', None)
    for recipe_name in ('e2e-gate', 'full-build'):
        record.unlink(missing_ok=True)
        r = subprocess.run(['just', recipe_name], cwd=ROOT, env=run_env, text=True, capture_output=True)
        assert r.returncode == 0, r.stderr
        chosen = Path(record.read_text())
        paths, markers = cc.plan(env)
        assert chosen == Path(env['RUNNER_TEMP']) / 'pw-profile-777-2'
        assert chosen in paths and chosen in markers


# --- workflow wiring ----------------------------------------------------------

def test_every_job_that_builds_isos_or_browsers_has_an_always_cleanup_step():
    workflow = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
    for name in ('e2e', 'full-matrix'):
        steps = workflow['jobs'][name]['steps']
        last = steps[-1]
        assert last['if'] == 'always()', name
        assert 'just ci-cleanup' in last['run'], name
        assert 'timeout-minutes' in last, name
