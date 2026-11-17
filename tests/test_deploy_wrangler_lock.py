"""wrangler for the two production deploys is one exact version with a lockfile.

The deploy job publishes iso.tunaos.org from app/ and relay.tunaos.org from
worker/ with wrangler, holding the Cloudflare API token. A version range there
is resolved from the npm registry at deploy time, so the code that holds the
token changes with no commit in this repository. app/ and worker/ therefore
each name one exact wrangler version, and a lockfile records every package
under it with its registry digest.
"""
import json
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).parents[1]
DEPLOY_DIRS = ('app', 'worker')
EXACT = re.compile(r'\d+\.\d+\.\d+')


def manifest(directory):
    return json.loads((ROOT / directory / 'package.json').read_text())


def lockfile(directory):
    return json.loads((ROOT / directory / 'package-lock.json').read_text())


@pytest.mark.parametrize('directory', DEPLOY_DIRS)
def test_wrangler_is_one_exact_version(directory):
    wanted = manifest(directory)['devDependencies']['wrangler']
    assert EXACT.fullmatch(wanted), f'{directory}/package.json: wrangler {wanted!r} is a range, not one version'


@pytest.mark.parametrize('directory', DEPLOY_DIRS)
def test_lockfile_records_that_version(directory):
    wanted = manifest(directory)['devDependencies']['wrangler']
    lock = lockfile(directory)
    assert lock['packages']['']['devDependencies'] == {'wrangler': wanted}
    assert lock['packages']['node_modules/wrangler']['version'] == wanted


@pytest.mark.parametrize('directory', DEPLOY_DIRS)
def test_every_locked_package_has_a_registry_digest(directory):
    packages = {name: entry for name, entry in lockfile(directory)['packages'].items() if name}
    assert packages
    for name, entry in packages.items():
        assert entry.get('resolved', '').startswith('https://registry.npmjs.org/'), f'{directory}: {name} is not from the npm registry'
        assert entry.get('integrity', '').startswith('sha512-'), f'{directory}: {name} has no sha512 digest'


def test_app_and_relay_deploy_with_the_same_wrangler():
    versions = {manifest(directory)['devDependencies']['wrangler'] for directory in DEPLOY_DIRS}
    assert len(versions) == 1, f'app and worker name different wrangler versions: {sorted(versions)}'
