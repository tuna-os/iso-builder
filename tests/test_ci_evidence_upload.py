"""ci.yml contract: browser evidence and harness output survive a guest failure."""
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from ci_sources import recipe  # noqa: E402
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
STEPS = WORKFLOW['jobs']['full-matrix']['steps']


def index(prefix):
    return next(i for i, s in enumerate(STEPS) if s.get('name', '').startswith(prefix))


def step(prefix):
    return STEPS[index(prefix)]


def test_order_guest_then_diagnostic_label_then_uploads():
    guest = index('verify guest under QEMU')
    output = index('label diagnostic output and make guest harness output readable')
    evidence = index('upload browser evidence')
    diag = index('upload diagnostics')
    assert guest < output < diag
    assert output < evidence

def test_cleanup_and_uploads_run_after_guest_failure():
    for prefix in ('label diagnostic output', 'upload browser evidence', 'upload diagnostics'):
        condition = str(step(prefix)['if'])
        assert 'always()' in condition, prefix
    assert str(step('label diagnostic output')['if']) == 'always()'
    assert '!cancelled()' in str(step('upload browser evidence')['if'])


def test_cleanup_labels_strict_receipt_before_it_changes_ownership():
    step_config = step('label diagnostic output')
    assert step_config['run'].strip() == 'just full-label-output'
    run = recipe('full-label-output')
    assert 'finalize-diagnostic-output.py' in run
    assert run.index('finalize-diagnostic-output.py') < run.index('sudo chown -R')
    assert step_config['env']['STRICT_ROUNDTRIP_TEST'] == "${{ github.event.inputs.strict_roundtrip_test }}"


def test_browser_evidence_needs_only_the_build_and_not_the_guest():
    s = step('upload browser evidence')
    condition = str(s['if'])
    assert "steps.browser-build.outcome == 'success'" in condition
    assert 'guest' not in condition and 'success()' not in condition.replace('always()', '')
    assert s['with']['path'] == 'e2e/test-results/*.json'
    assert s['with']['if-no-files-found'] == 'error'
    assert 'run${{ github.run_id }}' in s['with']['name'] and 'run_attempt' in s['with']['name']


def test_qualification_evidence_upload_stays_success_only():
    for prefix in ('upload qualification evidence', 'validate + merge qualification evidence'):
        condition = str(step(prefix)['if'])
        assert 'success()' in condition
        assert "strict_roundtrip_test != 'true'" in condition


def test_guest_step_installs_what_the_strict_walkthrough_measures_with():
    assert step('verify guest under QEMU')['run'].strip() == 'just full-guest-verify'
    run = recipe('full-guest-verify')
    install = run[run.index('apt-get install'):]
    install = install[:install.index('\n\n')]
    packages = set(install.replace('\\', ' ').split())
    # Without ImageMagick and tesseract the walkthrough reports every frame blank.
    assert {'imagemagick', 'tesseract-ocr', 'sshpass', 'jq'} <= packages
    # Still present: what the harness needs to boot the guest with a TPM.
    assert {'qemu-system-x86', 'qemu-utils', 'ovmf', 'swtpm', 'socat', 'netpbm', 'python3-pil'} <= packages


def test_job_scoped_cleanup_is_the_last_step_and_always_runs():
    last = STEPS[-1]
    assert last['name'].startswith('cleanup (')
    assert str(last['if']) == 'always()'
    assert 'just ci-cleanup' in last['run']
    # SLUG scopes the removal to this cell's own ISOs and harness output.
    assert last['env']['SLUG'] == '${{ matrix.edition.slug }}'
    # Every step that reads test-results/ or luks-verify-*/ runs before it.
    for prefix in ('upload browser evidence', 'upload diagnostics', 'upload qualification evidence',
                   'validate + merge qualification evidence', 'label diagnostic output'):
        assert index(prefix) < len(STEPS) - 1
