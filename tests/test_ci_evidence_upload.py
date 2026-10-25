"""ci.yml contract: browser evidence and harness output survive a guest failure."""
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
STEPS = WORKFLOW['jobs']['full-matrix']['steps']


def index(prefix):
    return next(i for i, s in enumerate(STEPS) if s.get('name', '').startswith(prefix))


def step(prefix):
    return STEPS[index(prefix)]


def test_order_guest_then_chown_then_uploads():
    guest = index('verify guest under QEMU')
    chown = index('make guest harness output readable')
    evidence = index('upload browser evidence')
    diag = index('upload diagnostics')
    assert guest < chown < diag
    assert guest < evidence


def test_chown_and_uploads_run_after_guest_failure():
    for prefix in ('make guest harness output readable', 'upload browser evidence', 'upload diagnostics'):
        cond = str(step(prefix)['if'])
        assert 'always()' in cond, prefix
    assert '!cancelled()' in str(step('make guest harness output readable')['if'])
    assert '!cancelled()' in str(step('upload browser evidence')['if'])


def test_chown_hands_back_the_harness_tree_with_no_error_swallowing():
    run = step('make guest harness output readable')['run']
    assert 'sudo chown -R' in run and 'luks-verify-' in run
    assert '|| true' not in run and 'set -euo pipefail' in run


def test_browser_evidence_needs_only_the_build_and_not_the_guest():
    s = step('upload browser evidence')
    cond = str(s['if'])
    assert "steps.browser-build.outcome == 'success'" in cond
    assert 'guest' not in cond and 'success()' not in cond.replace('always()', '')
    assert s['with']['path'] == 'e2e/test-results/*.json'
    assert s['with']['if-no-files-found'] == 'error'
    assert 'run${{ github.run_id }}' in s['with']['name'] and 'run_attempt' in s['with']['name']


def test_qualification_evidence_upload_stays_success_only():
    assert str(step('upload qualification evidence')['if']) == 'success()'
    assert str(step('validate + merge qualification evidence')['if']) == 'success()'


def test_guest_step_installs_what_the_strict_walkthrough_measures_with():
    run = step('verify guest under QEMU')['run']
    install = run[run.index('apt-get install'):]
    install = install[:install.index('\n\n')]
    packages = set(install.replace('\\', ' ').split())
    # Without ImageMagick and tesseract the walkthrough reports every frame blank.
    assert {'imagemagick', 'tesseract-ocr', 'sshpass', 'jq'} <= packages
    # Still present: what the harness needs to boot the guest with a TPM.
    assert {'qemu-system-x86', 'qemu-utils', 'ovmf', 'swtpm', 'socat', 'netpbm', 'python3-pil'} <= packages
