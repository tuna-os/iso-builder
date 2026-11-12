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
sys.path.insert(0, str(ROOT / 'tests'))
from ci_sources import pinned_commit  # noqa: E402

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


def browser_setup(tmp_path, *, cached=True, context=None, launch_failure=False):
    """Execute the real recipe and its JS runtime probe, with no package I/O."""
    bins = tmp_path / 'bin'
    bins.mkdir()
    e2e = tmp_path / 'e2e'
    package = e2e / 'node_modules/@playwright/test'
    package.mkdir(parents=True)
    log = tmp_path / 'setup.log'
    for name in ('npm', 'npx', 'sudo'):
        stub = bins / name
        stub.write_text(f'#!/bin/sh\nprintf "%s\\n" "{name} $*" >> "$SETUP_LOG"\n'
                        + ('exit 97\n' if name == 'sudo' else 'exit 0\n'))
        stub.chmod(0o755)
    (package / 'index.js').write_text(
        'const fs = require("node:fs"); const log = value => fs.appendFileSync(process.env.SETUP_LOG, value + "\\n");\n'
        'exports.chromium = { launch: async options => { log("launch " + JSON.stringify(options));\n'
        'if (process.env.LAUNCH_FAILURE === "1") throw new Error("missing Chromium library");\n'
        'return { version: () => "fixture-version", close: async () => { log("close"); } }; } };\n')
    env = {**os.environ, 'PATH': f'{bins}:{os.environ["PATH"]}', 'SETUP_LOG': str(log),
           'CACHE_HIT': str(cached).lower(), 'PREINSTALLED_BROWSER_DEPS': 'true',
           'GITHUB_ACTIONS': 'true', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'ImageOS': 'ubuntu24',
           'LAUNCH_FAILURE': '1' if launch_failure else '0', **(context or {})}
    result = subprocess.run(['just', '--justfile', str(ROOT / 'justfile'), '--working-directory',
                             str(tmp_path), 'e2e-install'], env=env, text=True, capture_output=True)
    return result, log.read_text().splitlines() if log.exists() else []


@needs_just
@pytest.mark.parametrize('cached', [False, True])
def test_preinstalled_runner_requires_exact_browser_launch_and_close(tmp_path, cached):
    result, calls = browser_setup(tmp_path, cached=cached)
    assert result.returncode == 0, result.stderr
    assert calls == ['npm ci', *([] if cached else ['npx playwright install chromium']),
                     'launch {"args":["--disable-dev-shm-usage"]}', 'close']
    assert 'Chromium runtime ready: fixture-version' in result.stdout


@needs_just
def test_missing_preinstalled_browser_library_fails_without_apt_fallback(tmp_path):
    result, calls = browser_setup(tmp_path, launch_failure=True)
    assert result.returncode != 0 and 'missing Chromium library' in result.stderr
    assert calls == ['npm ci', 'launch {"args":["--disable-dev-shm-usage"]}']


@needs_just
@pytest.mark.parametrize('context', [
    {'GITHUB_ACTIONS': ''}, {'RUNNER_OS': 'Darwin'}, {'RUNNER_ARCH': 'ARM64'},
    {'ImageOS': 'ubuntu26'}, {'PREINSTALLED_BROWSER_DEPS': '1'},
])
def test_preinstalled_browser_route_refuses_other_contexts_before_package_io(tmp_path, context):
    result, calls = browser_setup(tmp_path, context=context)
    assert result.returncode != 0 and 'requires the Ubuntu 24.04 x64' in result.stderr
    assert calls == []


@needs_just
@pytest.mark.parametrize('cached', [False, True])
def test_normal_browser_setup_keeps_system_dependency_install(tmp_path, cached):
    result, calls = browser_setup(tmp_path, cached=cached, context={'PREINSTALLED_BROWSER_DEPS': ''})
    assert result.returncode == 0, result.stderr
    assert calls == ['npm ci', 'npx playwright ' + ('install-deps chromium' if cached else 'install --with-deps chromium')]


def test_full_runner_uses_existing_pinned_just_and_preserves_setup_cap():
    jobs = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())['jobs']
    full = jobs['full-matrix']
    # Hosted by default; only a karnataka-gpu dispatch selects the self-hosted scale set.
    assert full['runs-on'] == "${{ github.event.inputs.runner == 'karnataka-gpu' && 'tuna-iso-gpu' || 'ubuntu-24.04' }}"
    steps = full['steps']
    tool = next(step for step in steps if step.get('name') == 'install pinned just without apt')
    assert tool['uses'].startswith('extractions/setup-just@')
    assert pinned_commit('ci.yml', tool['uses']) == '53165ef7e734c5c07cb06b3c8e7b647c5aa16db3'
    setup = next(step for step in steps if step.get('name') == 'install deps + chromium')
    assert setup['timeout-minutes'] == 20
    assert setup['run'] == 'just e2e-install'
    assert setup['env']['PREINSTALLED_BROWSER_DEPS'] == "${{ github.event.inputs.runner == 'karnataka-gpu' && '' || 'true' }}"
    assert steps.index(tool) < steps.index(setup)
    assert all('PREINSTALLED_BROWSER_DEPS' not in step.get('env', {}) for step in jobs['e2e']['steps'])


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


def pair_samples(over=None):
    over = over or {}
    files = {}
    for n in range(1, 7):
        cold = n % 2 == 1
        rt = {'completeLayerBlobs': 3 if cold else 0, 'completeLayerBytes': 300 if cold else 0, 'blobRequests': 4 if cold else 1,
              'blobBytes': 310 if cold else 10, 'incompleteBlobRequests': 0, 'inFlightBlobRequests': 0,
              'unknownSizeRequests': 0, 'observer': {'errors': [], 'blobBodyBytesRead': 0},
              'completeLayers': [{'digest': 'sha256:' + 'a' * 64, 'bytes': 100}] * (3 if cold else 0),
              'manifests': [{'digest': 'sha256:' + 'b' * 64}]}
        rt.update(over.get(n, {}))
        files[f'qual-evidence-x-s{n}.json'] = evidence(
            run={'sample': n, 'pair': (n + 1) // 2, 'cacheMode': 'cold' if cold else 'warm'},
            qualification='diagnostic-unqualified',
            resources={'isoBytes': 1000, 'peakTboxWasmMB': 5, 'peakTboxJsHeapMB': 6, 'opfsUsage': 400, 'opfsQuota': 10000,
                       'cacheLayersBefore': 0 if cold else 3},
            pairProtocol={'environment': {'frontendRevision': 'f' * 40, 'frontend': {'app.js': 'sha256:' + 'a' * 64},
                          'engineModule': 'github.com/tuna-os/tacklebox public-fixture', 'resources': {'totalMemoryBytes': 10000},
                          'memoryMethod': 'public fixture', 'registryFallback': False, 'goSumSha256': 'sha256:' + 'a' * 64,
                          'playwrightLockSha256': 'sha256:' + 'a' * 64}, 'source': {'platformManifestDigest': 'sha256:' + 'b' * 64,
                          'indexDigest': 'sha256:' + 'e' * 64, 'configDigest': 'sha256:' + 'f' * 64},
                          'overlay': {'platformManifestDigest': 'sha256:' + 'd' * 64}, 'requestSha256': 'sha256:' + 'a' * 64, 'profile': '/public-fixture/profile'},
            phasesMs={'inspect': 10, 'build': 20, 'save': 30, 'wall': 70}, registryTransfers=rt)
        files[f'build-attempt-x-s{n}.json'] = {'sample': n, 'exitCode': 0}
        files[f'build-measurements-qual-evidence-x-s{n}.json'] = {
            'iso': {'sha256': 'sha256:' + 'c' * 64, 'sizeBytes': 1000},
            'loadedWasm': {'sha256': 'sha256:' + 'a' * 64, 'sizeBytes': 8}, 'browser': {'product': 'Chrome/1.2.3.4', 'userAgent': 'public-fixture'},
            'engineBuildResult': {'bytesWritten': 1000, 'observedInputs': {
                'source': {'manifestDigest': 'sha256:' + 'b' * 64, 'indexDigest': 'sha256:' + 'e' * 64,
                           'config': {'descriptor': {'digest': 'sha256:' + 'f' * 64}, 'bytesVerified': True}},
                'overlay': {'manifestDigest': 'sha256:' + 'd' * 64, 'baseAnnotationMatched': True, 'layersApplied': True}}}}
    return files


def test_pair_summarizes_three_cold_warm_pairs_with_identities(tmp_path):
    r = validate(tmp_path, pair_samples(), PAIR='true')
    assert r.returncode == 0, r.stderr
    merged = json.loads((tmp_path / 'test-results/qual-evidence-x-pairs.json').read_text())
    assert [p['pair'] for p in merged['pairs']] == [1, 2, 3]
    warm = merged['pairs'][0]['warm']
    assert warm['sample'] == 2 and warm['transfer']['completeLayerBlobs'] == 0 and warm['wallMs'] == 70
    assert warm['identity']['iso']['sha256'] == 'sha256:' + 'c' * 64
    assert merged['qualification'] == 'diagnostic-unqualified'
    assert 'no install' in merged['qualificationScope']


def test_pair_rejects_warm_layer_fetch_and_changed_inputs(tmp_path):
    fetched = {4: {'completeLayerBlobs': 1, 'completeLayers': [{'digest': 'sha256:' + 'd' * 64, 'bytes': 9}]}}
    r = validate(tmp_path, pair_samples(fetched), PAIR='true')
    assert r.returncode != 0 and 'pair 2: warm sample fetched complete layer blobs' in r.stderr and 'd' * 64 in r.stderr
    (tmp_path / 'b').mkdir()
    r = validate(tmp_path / 'b', pair_samples({6: {'manifests': [{'digest': 'sha256:' + 'e' * 64}]}}), PAIR='true')
    assert r.returncode != 0 and 'pair 3: inputs changed' in r.stderr
    (tmp_path / 'c').mkdir()
    r = validate(tmp_path / 'c', pair_samples({1: {'completeLayerBlobs': 0, 'completeLayers': []}}), PAIR='true')
    assert r.returncode != 0 and 'pair 1: cold sample observed no complete layer downloads' in r.stderr


def test_pair_needs_six_samples(tmp_path):
    files = {k: v for k, v in pair_samples().items() if not k.endswith('-s6.json')}
    r = validate(tmp_path, files, PAIR='true')
    assert r.returncode != 0 and 'pair mode needs samples 1-6' in r.stderr


# --- scripts/plan-full-matrix.py: pair=true --------------------------------------------------

def plan(**env):
    base = dict(RUN_FULL='true', ONLY='yellowfin-gnome', BENCHMARK='false', KEEP_ISO='false', RETAIN_CANDIDATE='false',
                RETAIN_ISO_ARTIFACT='false', STRICT_ROUNDTRIP_TEST='false', DIAGNOSTIC_UNQUALIFIED='false', PAIR='true')
    return subprocess.run([sys.executable, 'scripts/plan-full-matrix.py'], cwd=ROOT,
                          env={**os.environ, **base, **env}, text=True, capture_output=True)


def test_plan_accepts_pair_mode():
    r = plan()
    assert r.returncode == 0, r.stderr
    assert 'count=1' in r.stdout and '"slug": "yellowfin-gnome"' in r.stdout
    assert plan(ONLY='').returncode == 0


@pytest.mark.parametrize('key,value', [('RUN_FULL', 'false'), ('BENCHMARK', 'true'), ('KEEP_ISO', 'true'),
                                       ('RETAIN_CANDIDATE', 'true'), ('RETAIN_ISO_ARTIFACT', 'true'),
                                       ('STRICT_ROUNDTRIP_TEST', 'true')])
def test_plan_rejects_pair_with_exclusive_inputs(key, value):
    r = plan(**{key: value})
    assert r.returncode != 0 and 'pair=true requires' in r.stderr


def test_plan_default_is_unchanged_by_pair_input():
    r = plan(PAIR='false', BENCHMARK='true')
    assert r.returncode == 0, r.stderr


# --- full-build: the pair protocol as the recipe runs it ------------------------------------

@needs_just
@pytest.mark.parametrize('mode,expected', [
    ({}, ['1 cold - -']),
    ({'BENCHMARK': 'true'}, ['1 cold - -', '2 cold - -', '3 cold - -']),
    ({'PAIR': 'true'}, ['1 cold 1 1', '2 warm 1 -', '3 cold 2 1', '4 warm 2 -', '5 cold 3 1', '6 warm 3 -']),
])
def test_full_build_sequences_samples(tmp_path, mode, expected):
    """A fake npx records each sample's env; real profile reuse is the spec fixture's job."""
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    log = tmp_path / 'samples.log'
    (bin_dir / 'npx').write_text(
        '#!/usr/bin/env bash\n'
        f'echo "$TBOX_E2E_SAMPLE $TBOX_E2E_CACHE_MODE ${{TBOX_E2E_PAIR:--}} ${{TBOX_E2E_PROFILE_KEEP:--}}" >> {log}\n'
        'if [ -n "$TBOX_E2E_ISO_COPY" ]; then : > "$TBOX_E2E_ISO_COPY"; fi\n')
    (bin_dir / 'npx').chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('TBOX_E2E_', 'GITHUB_'))}
    env.update(PATH=f'{bin_dir}:{env["PATH"]}', SLUG='x', RUNNER_TEMP=str(tmp_path), TBOX_E2E_CACHE_MODE='cold', **mode)
    r = subprocess.run(['just', 'full-build'], cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode == 0, r.stderr
    assert log.read_text().splitlines() == expected
    assert sorted(p.name for p in tmp_path.glob('*.iso')) == ([] if mode.get('PAIR') == 'true' else ['x-s%s.iso' % len(expected), 'x.iso'])


@needs_just
def test_full_build_refuses_pair_with_benchmark(tmp_path):
    env = {**os.environ, 'SLUG': 'x', 'RUNNER_TEMP': str(tmp_path), 'PAIR': 'true', 'BENCHMARK': 'true'}
    r = subprocess.run(['just', 'full-build'], cwd=ROOT, env=env, text=True, capture_output=True)
    assert r.returncode != 0 and 'mutually exclusive' in r.stderr


@pytest.mark.parametrize('mutation,message', [
    ('failed', 'missing successful attempt outcome'),
    ('missing-iso', 'missing measured iso integrity'),
    ('inflight', 'incomplete registry observation'),
    ('unknown-bytes', 'incomplete registry observation'),
    ('observer-error', 'incomplete registry observation'),
    ('profile', 'changed persistent profile'),
    ('frontend', 'changed fixed environment'),
    ('request', 'changed fixed requestSha256'),
    ('wasm', 'changed measured loadedWasm'),
    ('browser', 'changed measured browser'),
    ('source', 'engine/media integrity or fixed input mismatch'),
    ('bytes', 'engine/media integrity or fixed input mismatch'),
    ('cold-cache', 'OPFS cache preconditions'),
    ('memory', 'missing resource'),
])
def test_pair_rejects_incomplete_or_changed_measurements(tmp_path, mutation, message):
    files = pair_samples()
    ev = files['qual-evidence-x-s2.json']
    measurement = files['build-measurements-qual-evidence-x-s2.json']
    if mutation == 'failed':
        files['build-attempt-x-s2.json']['exitCode'] = 1
    elif mutation == 'missing-iso':
        measurement['iso'] = None
    elif mutation in ('inflight', 'unknown-bytes'):
        ev['registryTransfers']['inFlightBlobRequests' if mutation == 'inflight' else 'unknownSizeRequests'] = 1
    elif mutation == 'observer-error':
        ev['registryTransfers']['observer']['errors'] = ['manifest unavailable']
    elif mutation == 'profile':
        ev['pairProtocol']['profile'] += '-other'
    elif mutation == 'frontend':
        ev['pairProtocol']['environment']['frontendRevision'] = '0' * 40
    elif mutation == 'request':
        ev['pairProtocol']['requestSha256'] = 'sha256:' + '0' * 64
    elif mutation == 'wasm':
        measurement['loadedWasm']['sha256'] = 'sha256:' + '0' * 64
    elif mutation == 'browser':
        measurement['browser']['product'] = 'Chrome/9.8.7.6'
    elif mutation == 'source':
        measurement['engineBuildResult']['observedInputs']['source']['manifestDigest'] = 'sha256:' + '0' * 64
    elif mutation == 'bytes':
        measurement['iso']['sizeBytes'] += 1
    elif mutation == 'cold-cache':
        files['qual-evidence-x-s1.json']['resources']['cacheLayersBefore'] = 3
    elif mutation == 'memory':
        ev['resources']['peakTboxWasmMB'] = -1
    r = validate(tmp_path, files, PAIR='true')
    assert r.returncode != 0 and message in r.stderr


@needs_just
@pytest.mark.parametrize('fail_at', [0, 2])
def test_pair_retains_receipts_across_real_playwright_output_cleanup(tmp_path, fail_at):
    """Exercise the real CLI's output cleanup with tiny public JSON, no ISO build."""
    modules = ROOT / 'e2e/node_modules'
    if not (modules / '@playwright/test').exists():
        pytest.skip('npm ci in e2e is required')
    work = tmp_path / 'e2e'
    work.mkdir()
    (work / 'node_modules').symlink_to(modules, target_is_directory=True)
    (work / 'playwright.config.js').write_text(
        'module.exports = { testDir: ".", workers: 1, retries: 0, reporter: "line" };')
    (work / 'receipt.spec.js').write_text(
        'const { test, expect } = require("@playwright/test"); const fs = require("node:fs");\n'
        'test("public receipt fixture @full", () => {\n'
        ' const n = Number(process.env.TBOX_E2E_SAMPLE); const file = process.env.TBOX_E2E_EVIDENCE;\n'
        ' fs.mkdirSync("test-results", { recursive: true });\n'
        ' fs.writeFileSync(file, JSON.stringify({ sample: n, fixture: true }));\n'
        ' fs.writeFileSync(file.replace("qual-evidence-", "build-measurements-qual-evidence-"), JSON.stringify({ sample: n, fixture: true }));\n'
        ' expect(n).not.toBe(Number(process.env.PUBLIC_FIXTURE_FAIL_AT));\n'
        '});')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('TBOX_E2E_', 'GITHUB_'))}
    env.update(SLUG='x', RUNNER_TEMP=str(tmp_path), PAIR='true', BENCHMARK='false',
               PUBLIC_FIXTURE_FAIL_AT=str(fail_at))
    r = subprocess.run(['just', '--justfile', str(ROOT / 'justfile'), '--working-directory', str(tmp_path),
                        'full-build'], env=env, text=True, capture_output=True)
    assert (r.returncode == 0) == (fail_at == 0), r.stderr + r.stdout
    count = fail_at or 6
    for n in range(1, count + 1):
        assert json.loads((work / f'test-results/qual-evidence-x-s{n}.json').read_text())['sample'] == n
        assert (work / f'test-results/build-measurements-qual-evidence-x-s{n}.json').exists()
        outcome = json.loads((work / f'test-results/build-attempt-x-s{n}.json').read_text())
        assert outcome == {'sample': n, 'exitCode': int(n == fail_at)}
    assert not (work / f'test-results/build-attempt-x-s{count + 1}.json').exists()
    assert not list(tmp_path.glob('*.iso'))


def test_gpu_runner_input_defaults_to_hosted_and_preflights_only_on_karnataka():
    wf = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
    on = wf.get('on', wf.get(True))
    runner = on['workflow_dispatch']['inputs']['runner']
    assert runner['type'] == 'choice' and runner['default'] == 'github'
    assert runner['options'] == ['github', 'karnataka-gpu']
    steps = wf['jobs']['full-matrix']['steps']
    pre = next(step for step in steps if step.get('name') == 'preflight GPU host (karnataka-gpu only)')
    assert pre['if'] == "github.event.inputs.runner == 'karnataka-gpu'"
    assert pre['run'] == 'just gpu-host-preflight'
    just = next(step for step in steps if step.get('name') == 'install pinned just without apt')
    # The preflight is a just recipe, and the karnataka runner image has no just.
    assert steps.index(just) == 1 and steps.index(pre) == 2, 'install just, then preflight before any build work'


def test_kvm_udev_rule_is_skipped_when_kvm_is_already_accessible():
    text = (ROOT / 'justfile').read_text()
    assert text.count('if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then') == 2
    assert text.count('sudo udevadm control --reload-rules') == 2
