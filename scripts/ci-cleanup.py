#!/usr/bin/env python3
"""Job-scoped CI cleanup: remove what THIS run created and nothing else.

Invoked as `just ci-cleanup` from an `if: always()` step. Everything it may
touch is derived from the run identity and the job's SLUG, never from a glob
over shared state:

  $RUNNER_TEMP    <slug>.iso, <slug>-roundtrip.iso, <slug>-s<N>.iso (the multi-GB
                  ISOs), iso-artifact/, iso-roundtrip/, the retention scratch
                  files, the candidate-retention venv, and the run-scoped
                  Playwright profile root pw-profile-<run>-<attempt>/.
  $GITHUB_WORKSPACE
                  luks-verify-<slug>/ and the same-byte variant (harness
                  output: serial logs, multi-GB qcow2 disks, swtpm state, often
                  root-owned), and the Playwright output under e2e/.
  processes       QEMU/swtpm started by the guest harness against those
                  luks-verify dirs, and Chromium started against the profile
                  root: matched by an absolute path of ours on their command
                  line, never by name.

Contract:
  * Idempotent and safe when nothing exists; failures to delete are warnings,
    not job failures (a cleanup step must never redden a green job).
  * Refuses (exit 1) instead of deleting anything outside RUNNER_TEMP or
    GITHUB_WORKSPACE, or anything named by an unsafe SLUG, or when a root is
    the filesystem root or $HOME.
  * Outside a CI run (no GITHUB_RUN_ID) it owns nothing and does nothing.
  * DRY_RUN=1 prints what it would do and changes nothing.

Environment: RUNNER_TEMP, GITHUB_WORKSPACE (default: cwd), GITHUB_RUN_ID,
GITHUB_RUN_ATTEMPT (default 1), SLUG (comma-separated list allowed),
DRY_RUN, CI_CLEANUP_KILL_GRACE (seconds before SIGKILL, default 5).
"""
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

SLUG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
TEMP_SCRATCH = ('iso-artifact', 'iso-roundtrip', 'iso-artifact-manifest.json',
                'iso-roundtrip-result.json', 'same-byte-inputs.env',
                'candidate-retention-venv')
E2E_OUTPUT = ('test-results', 'playwright-report', 'screenshots', 'iso-builder-e2e-output.iso')


class NotOwned(Exception):
    """A path fell outside what this job may delete."""


def _slugs(env):
    slugs = [s for s in re.split(r'[,\s]+', env.get('SLUG', '')) if s]
    for s in slugs:
        if not SLUG_RE.fullmatch(s):
            raise NotOwned(f'refusing unsafe SLUG {s!r}')
    return slugs


def _root(value, label, env):
    root = Path(value).resolve()
    home = env.get('HOME')
    if root == Path(root.anchor) or (home and root == Path(home).resolve()):
        raise NotOwned(f'refusing {label}={root}: not a job-scoped directory')
    return root


def _within(path, root):
    # Resolve the parent only: a symlink at `path` is removed as a link and
    # never followed, so a planted link cannot redirect the deletion.
    real = path.parent.resolve() / path.name
    return root in real.parents


def plan(env):
    """Return (paths_to_remove, process_markers) derived from env.

    Raises NotOwned for anything that would leave the job's roots. Paths are
    returned whether or not they exist; the caller skips missing ones.
    """
    run_id = env.get('GITHUB_RUN_ID', '')
    if not run_id:
        return [], []
    if not re.fullmatch(r'[0-9]+', run_id):
        raise NotOwned(f'refusing non-numeric GITHUB_RUN_ID {run_id!r}')
    attempt = env.get('GITHUB_RUN_ATTEMPT') or '1'
    if not re.fullmatch(r'[0-9]+', attempt):
        raise NotOwned(f'refusing non-numeric GITHUB_RUN_ATTEMPT {attempt!r}')
    slugs = _slugs(env)
    temp = _root(env['RUNNER_TEMP'], 'RUNNER_TEMP', env) if env.get('RUNNER_TEMP') else None
    ws = _root(env.get('GITHUB_WORKSPACE') or os.getcwd(), 'GITHUB_WORKSPACE', env)

    owned = []   # (path, root)
    markers = []
    if temp is not None:
        profile = temp / f'pw-profile-{run_id}-{attempt}'
        owned.append((profile, temp))
        markers.append(profile)
        for name in TEMP_SCRATCH:
            owned.append((temp / name, temp))
        for slug in slugs:
            owned.append((temp / f'{slug}.iso', temp))
            owned.append((temp / f'{slug}-roundtrip.iso', temp))
            if temp.is_dir():
                pattern = re.compile(rf'{re.escape(slug)}-s[0-9]+\.iso')
                owned.extend((temp / n, temp) for n in sorted(os.listdir(temp)) if pattern.fullmatch(n))
    for slug in slugs:
        for suffix in ('', '-diag'):
            d = ws / f'luks-verify-{slug}{suffix}'
            owned.append((d, ws))
            markers.append(d)
    for name in E2E_OUTPUT:
        owned.append((ws / 'e2e' / name, ws))

    paths = []
    for path, root in owned:
        if not _within(path, root):
            raise NotOwned(f'refusing {path}: outside {root}')
        paths.append(path)
    return paths, markers


def _size(path):
    try:
        if path.is_symlink() or path.is_file():
            return path.lstat().st_size
        total = 0
        for base, _dirs, files in os.walk(path, onerror=lambda _e: None):
            for f in files:
                try:
                    total += os.lstat(os.path.join(base, f)).st_size
                except OSError:
                    pass
        return total
    except OSError:
        return 0


def _remove(path):
    """Remove one owned path; escalate to sudo for root-owned harness output."""
    if path.is_symlink() or path.is_file():
        try:
            path.unlink()
            return True
        except OSError:
            pass
    else:
        try:
            shutil.rmtree(path)
            return True
        except OSError:
            pass
    # The guest harness runs under sudo; its output tree can be root-owned.
    rc = subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(path)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    return rc == 0 and not os.path.lexists(path)


def _cmdlines(proc_root):
    own = {os.getpid(), os.getppid()}
    for entry in os.listdir(proc_root):
        if not entry.isdigit() or int(entry) in own:
            continue
        try:
            raw = (Path(proc_root) / entry / 'cmdline').read_bytes()
        except OSError:
            continue
        yield int(entry), raw.decode('utf-8', 'replace')


def find_pids(markers, proc_root='/proc'):
    """PIDs whose argv carries one of our absolute paths as a whole path.

    The path must not continue a longer name on either side: luks-verify-a never
    matches luks-verify-ab, and /x/luks-verify-a never matches /y/x/luks-verify-a.
    """
    if not markers:
        return []
    alternation = '|'.join(re.escape(str(m)) for m in markers)
    pattern = re.compile(rf'(?<![\w.\-/])(?:{alternation})(?![\w.\-])')
    return [pid for pid, cmd in _cmdlines(proc_root) if pattern.search(cmd)]


def _signal(pid, sig):
    try:
        os.kill(pid, sig)
        return
    except ProcessLookupError:
        return
    except PermissionError:
        pass
    subprocess.run(['sudo', '-n', 'kill', f'-{int(sig)}', str(pid)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # a zombie is dead for our purposes
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z'
    except OSError:
        return True


def stop(pids, grace):
    for pid in pids:
        _signal(pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and any(_alive(p) for p in pids):
        time.sleep(0.1)
    for pid in pids:
        if _alive(pid):
            _signal(pid, signal.SIGKILL)


def main(env=None, proc_root='/proc'):
    env = dict(os.environ if env is None else env)
    dry = env.get('DRY_RUN', '') not in ('', '0', 'false')
    try:
        paths, markers = plan(env)
    except NotOwned as e:
        print(f'::error::ci-cleanup: {e}', file=sys.stderr)
        return 1
    if not env.get('GITHUB_RUN_ID'):
        print('ci-cleanup: no GITHUB_RUN_ID; this is not a CI run, nothing is owned')
        return 0

    pids = find_pids(markers, proc_root)
    if pids:
        print(f'ci-cleanup: {"would stop" if dry else "stopping"} {len(pids)} process(es) '
              f'started against this job: {sorted(pids)}')
        if not dry:
            stop(pids, float(env.get('CI_CLEANUP_KILL_GRACE', '5')))

    freed = 0
    for path in paths:
        if not os.path.lexists(path):
            continue
        size = _size(path)
        if dry:
            print(f'ci-cleanup: would remove {path} ({size} bytes)')
            freed += size
        elif _remove(path):
            print(f'ci-cleanup: removed {path} ({size} bytes)')
            freed += size
        else:
            print(f'::warning::ci-cleanup: could not remove {path}')
    print(f'ci-cleanup: {"would free" if dry else "freed"} {freed} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
