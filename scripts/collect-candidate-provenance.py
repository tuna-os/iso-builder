#!/usr/bin/env python3
"""Local producer/served-tree observations, never an authenticated receipt.

This proposal is not wired into CI. GitHub environment fields are claims until
an external consumer verifies the run/job and artifact association. Hashes of
local served files do not prove that the browser received them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = 'tuna-os/iso-builder'
GENERATED = {'app/public/tbox.wasm', 'app/public/wasm_exec.js'}
# The workflow and the justfile whose recipes its steps run are one producer:
# the build, guest-verify and retention logic lives in the recipes.
WORKFLOW_FILES = ('.github/workflows/ci.yml', 'justfile')


def git(root, *args):
    return subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), *args], text=True).strip()


def digest_file(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'expected a regular, non-symlink file: {path.name}')
    before = path.stat()
    h = hashlib.sha256()
    with path.open('rb') as f:
        opened = os.fstat(f.fileno())
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
        after = os.fstat(f.fileno())
    named = path.stat()
    def identity(st):
        return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns
    if not identity(before) == identity(opened) == identity(after) == identity(named):
        raise ValueError('file changed while hashing')
    if after.st_size <= 0:
        raise ValueError('empty artifact')
    return {'sha256': 'sha256:' + h.hexdigest(), 'sizeBytes': after.st_size}


def checkout_file_digest(root, head, relative):
    proc = subprocess.Popen(['git', '--no-replace-objects', '-C', str(root), 'cat-file', 'blob', f'{head}:{relative}'], stdout=subprocess.PIPE)
    h, size = hashlib.sha256(), 0
    with proc.stdout:
        for chunk in iter(lambda: proc.stdout.read(1024 * 1024), b''):
            size += len(chunk)
            h.update(chunk)
    if proc.wait() != 0:
        raise ValueError('cannot read committed frontend blob')
    return {'sha256': 'sha256:' + h.hexdigest(), 'sizeBytes': size}


def collect(root, measurement, env, candidate_iso):
    root = Path(root).resolve()
    if env.get('GITHUB_ACTIONS') != 'true' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch':
        raise ValueError('manual GitHub Actions context required; this does not authenticate it')
    if env.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise ValueError('unexpected repository claim')
    head = git(root, 'rev-parse', 'HEAD')
    if not re.fullmatch(r'[0-9a-f]{40}', head) or env.get('GITHUB_SHA') != head:
        raise ValueError('checkout SHA and run SHA claim differ')
    for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        if not re.fullmatch(r'[1-9][0-9]*', env.get(key, '')):
            raise ValueError(f'invalid {key}')
    workflow_ref = env.get('GITHUB_WORKFLOW_REF', '')
    prefix = REPOSITORY + '/.github/workflows/ci.yml@'
    if not workflow_ref.startswith(prefix) or not workflow_ref[len(prefix):].startswith('refs/'):
        raise ValueError('unexpected workflow reference')
    workflow_sha = env.get('GITHUB_WORKFLOW_SHA', '')
    if not re.fullmatch(r'[0-9a-f]{40}', workflow_sha) or workflow_sha != head:
        raise ValueError('workflow SHA claim must equal reviewed checkout')
    job = env.get('GITHUB_JOB', '')
    if job != 'full-matrix':
        raise ValueError('unexpected job claim')
    if measurement.get('kind') != 'diagnostic-build-measurements' or measurement.get('qualification') != 'not-assessed':
        raise ValueError('expected unqualified diagnostic measurements')
    for key in ('iso', 'loadedWasm'):
        value = measurement.get(key, {})
        if (not isinstance(value, dict) or
                not isinstance(value.get('sha256'), str) or
                not re.fullmatch(r'sha256:[0-9a-f]{64}', value['sha256']) or
                type(value.get('sizeBytes')) is not int or value['sizeBytes'] <= 0):
            raise ValueError(f'invalid {key} measurement')
    observed_iso = digest_file(Path(candidate_iso))
    if observed_iso != measurement['iso']:
        raise ValueError('candidate ISO does not match browser observation')
    tracked = git(root, 'ls-tree', '-r', '--name-only', '-z', head, '--', 'app/public', *WORKFLOW_FILES).split('\0')
    paths = sorted(p for p in tracked if p)
    required = {'app/public/index.html', 'app/public/app.js', *WORKFLOW_FILES}
    if not required.issubset(paths):
        raise ValueError('missing tracked frontend/workflow files')
    if git(root, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'app/public', *WORKFLOW_FILES):
        raise ValueError('served frontend or workflow differs from checkout')
    unknown = set(filter(None, git(root, 'ls-files', '--others', '-z', '--', 'app/public').split('\0'))) - GENERATED
    if unknown:
        raise ValueError('unexpected untracked served files')
    observations = {}
    for relative in sorted(set(paths) | GENERATED):
        path = root / relative
        if path.resolve().is_relative_to(root) is False or any(p.is_symlink() for p in [path, *path.parents] if p != root and p.is_relative_to(root)):
            raise ValueError('served paths must not traverse symlinks')
        observations[relative] = digest_file(path)
        if relative in paths and observations[relative] != checkout_file_digest(root, head, relative):
            raise ValueError('served bytes do not match committed frontend/workflow blob')
    if observations['app/public/tbox.wasm'] != measurement['loadedWasm']:
        raise ValueError('served WASM does not match browser observation')
    if git(root, 'rev-parse', 'HEAD') != head or git(root, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'app/public', *WORKFLOW_FILES):
        raise ValueError('checkout changed during collection')
    return {
        'schemaVersion': 1,
        'kind': 'candidate-producer-observations',
        'qualification': 'not-assessed',
        'producerContext': {
            'authentication': 'not-verified', 'repository': REPOSITORY,
            'checkoutSha': head, 'workflowRef': workflow_ref, 'workflowSha': workflow_sha,
            'runId': env['GITHUB_RUN_ID'], 'runAttempt': env['GITHUB_RUN_ATTEMPT'], 'job': job,
        },
        'servedTree': {'browserDelivery': 'not-verified', 'files': observations},
        'iso': observed_iso,
        'loadedWasm': dict(measurement['loadedWasm']),
        'missingIdentity': ['authenticated-producer', 'browser-loaded-frontend', 'installed-installer-frontend'],
        'artifactBinding': 'not-verified',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--measurements', type=Path, required=True)
    args = parser.parse_args()
    if args.measurements.stat().st_size > 1024 * 1024:
        raise ValueError('measurement file exceeds 1 MiB')
    result = collect(args.root, json.loads(args.measurements.read_text()), os.environ, args.iso)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
