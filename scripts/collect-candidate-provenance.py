#!/usr/bin/env python3
"""Local producer/served-tree observations, never an authenticated receipt.

The opt-in retention step calls this collector. GitHub environment fields are
claims until an external consumer verifies the run/job and artifact association.
Loaded response hashes can match local files without authenticating the host.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

REPOSITORY = 'tuna-os/iso-builder'
GENERATED = {'app/public/tbox.wasm', 'app/public/wasm_exec.js'}
FRONTEND_REQUIRED = {'index.html', 'wasm_exec.js', 'layercache.js', 'build-result.js', 'app.js', 'tbox.wasm'}


def bind_loaded_frontend(record, served):
    """Compare host-observed response bytes, without authenticating the host."""
    if (not isinstance(record, dict) or type(record.get('schemaVersion')) is not int or
            record.get('schemaVersion') != 1 or record.get('kind') != 'diagnostic-loaded-frontend'):
        raise ValueError('invalid loaded frontend observation')
    if record.get('qualification') != 'not-assessed' or record.get('authentication') != 'not-verified':
        raise ValueError('frontend observation cannot claim authentication or qualification')
    if record.get('coverage') != 'page-target-only':
        raise ValueError('unsupported frontend target coverage')
    origin = record.get('origin')
    if not isinstance(origin, str) or not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', origin):
        raise ValueError('frontend origin must be the literal loopback server')
    doc = record.get('documentURL')
    if not isinstance(doc, str) or not doc.startswith(origin + '/'):
        raise ValueError('frontend document differs from loopback origin')
    document = urlsplit(doc)
    if document.path != '/' or document.fragment or document.username or document.password:
        raise ValueError('unexpected frontend document URL')
    assets = record.get('assets')
    if not isinstance(assets, list) or not 1 <= len(assets) <= 64:
        raise ValueError('invalid frontend response count')
    seen, result = set(), {}
    count, total_bytes = 0, 0
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get('url'), str):
            raise ValueError('invalid frontend asset')
        url = asset['url']
        if not url.startswith(origin + '/') or url in seen:
            raise ValueError('foreign or duplicate frontend URL')
        seen.add(url)
        parsed = urlsplit(url)
        if parsed.fragment or parsed.username or parsed.password:
            raise ValueError('invalid frontend URL')
        if asset.get('resourceType') == 'document':
            if url != doc or asset.get('responseCount') != 1:
                raise ValueError('frontend navigation changed')
            relative = 'app/public/index.html'
        else:
            if parsed.query or not re.fullmatch(r'/[A-Za-z0-9_.-]+', parsed.path):
                raise ValueError('frontend asset path is not canonical')
            relative = 'app/public' + parsed.path
        if relative in result:
            raise ValueError('ambiguous frontend file')
        if relative.endswith('.js') and asset.get('resourceType') != 'script':
            raise ValueError('frontend JavaScript was not observed as a script')
        if relative == 'app/public/index.html' and asset.get('resourceType') != 'document':
            raise ValueError('frontend HTML was not observed as a document')
        if relative.endswith('.wasm') and asset.get('resourceType') != 'wasm':
            raise ValueError('frontend WASM was not observed as WASM')
        if asset.get('resourceType') not in ('document', 'script', 'stylesheet', 'wasm'):
            raise ValueError('unknown frontend resource type')
        measured = {k: asset.get(k) for k in ('sha256', 'sizeBytes')}
        if (type(measured['sizeBytes']) is not int or not 0 < measured['sizeBytes'] <= 64 * 1024**2 or
                type(asset.get('responseCount')) is not int or not 1 <= asset['responseCount'] <= 64 or
                measured != served.get(relative)):
            raise ValueError('loaded frontend differs from served bytes')
        count += asset['responseCount']
        total_bytes += measured['sizeBytes'] * asset['responseCount']
        if count > 64 or total_bytes > 96 * 1024**2:
            raise ValueError('frontend responses exceed total limits')
        result[relative] = measured
    if not {'app/public/' + p for p in FRONTEND_REQUIRED}.issubset(result):
        raise ValueError('required frontend response is missing')
    return {'status': 'observed-bytes-match-served-tree', 'authentication': 'not-verified',
            'coverage': 'page-target-only',
            'files': result}


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
    tracked = git(root, 'ls-tree', '-r', '--name-only', '-z', head, '--', 'app/public', '.github/workflows/ci.yml').split('\0')
    paths = sorted(p for p in tracked if p)
    required = {'app/public/index.html', 'app/public/app.js', '.github/workflows/ci.yml'}
    if not required.issubset(paths):
        raise ValueError('missing tracked frontend/workflow files')
    if git(root, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'app/public', '.github/workflows/ci.yml'):
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
    frontend = measurement.get('loadedFrontend')
    binding = bind_loaded_frontend(frontend, observations) if frontend is not None else None
    if git(root, 'rev-parse', 'HEAD') != head or git(root, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'app/public', '.github/workflows/ci.yml'):
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
        'loadedFrontendBinding': binding,
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
