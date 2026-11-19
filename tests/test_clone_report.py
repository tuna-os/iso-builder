"""scripts/clone-report.py: lists clones that touch a change, and never fails (#553)."""
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('clone_report', ROOT / 'scripts/clone-report.py')
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)


def clone(a, b, fmt='go', lines=12):
    return {'format': fmt, 'lines': lines,
            'firstFile': {'name': a, 'start': 1, 'end': lines},
            'secondFile': {'name': b, 'start': 5, 'end': 4 + lines}}


REPORT = {'duplicates': [
    clone('native/blockdev_linux.go', 'desktop/helper/internal/drives/linuxfilter.go'),
    clone('native/blockdev_windows.go', 'desktop/helper/internal/drives/windowsfilter.go'),
    clone('worker/cors-shim.test.js', 'worker/cors-shim.test.js', fmt='javascript'),
]}


def test_only_clones_with_a_changed_side_are_reported():
    got = cr.clones_touching(REPORT, {'desktop/helper/internal/drives/linuxfilter.go', 'README.md'})
    assert [c['firstFile']['name'] for c in got] == ['native/blockdev_linux.go']
    assert cr.clones_touching(REPORT, set()) == []


def test_unknown_change_reports_every_clone():
    assert cr.clones_touching(REPORT, None) == REPORT['duplicates']
    assert cr.changed_files('') is None
    assert cr.changed_files('0' * 40) is None
    assert cr.changed_files('not-a-commit') is None


def test_changed_files_reads_the_three_dot_diff(tmp_path):
    def git(*args):
        return subprocess.run(['git', *args], cwd=tmp_path, check=True, text=True,
                              capture_output=True).stdout.strip()
    git('init', '-q')
    git('config', 'user.email', 't@example.invalid')
    git('config', 'user.name', 't')
    (tmp_path / 'a.go').write_text('a\n')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base')
    base = git('rev-parse', 'HEAD')
    (tmp_path / 'b.go').write_text('b\n')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'change')
    assert cr.changed_files(base, cwd=tmp_path) == {'b.go'}


def test_render_lists_both_sides():
    text = cr.render(REPORT['duplicates'][:1], {'native/blockdev_linux.go'})
    assert 'touching the 1 changed file(s): 1' in text
    assert '`native/blockdev_linux.go:1-12` ~ `desktop/helper/internal/drives/linuxfilter.go:5-16`' in text
    assert cr.render([], None).startswith('### Code clones in the repository: 0')


def test_main_writes_the_step_summary_and_exits_zero(tmp_path, capsys):
    report = tmp_path / 'jscpd-report.json'
    report.write_text(json.dumps(REPORT))
    summary = tmp_path / 'summary.md'
    assert cr.main({'JSCPD_REPORT': str(report), 'GITHUB_STEP_SUMMARY': str(summary)}) == 0
    assert 'Code clones in the repository: 3' in summary.read_text()
    assert 'cors-shim.test.js' in capsys.readouterr().out


def test_main_never_fails_without_a_report(tmp_path):
    assert cr.main({'JSCPD_REPORT': str(tmp_path / 'missing.json')}) == 0
    (tmp_path / 'bad.json').write_text('{')
    assert cr.main({'JSCPD_REPORT': str(tmp_path / 'bad.json')}) == 0


def test_config_skips_vendored_and_generated_trees():
    cfg = json.loads((ROOT / '.jscpd.json').read_text())
    for path in ('native/vncviewer/assets/**', 'app/public/guided-catalog-data.js',
                 'app/public/experience-data.js', 'app/public/builder-config-data.js'):
        assert path in cfg['ignore']
    for generated in ('guided-catalog-data.js', 'experience-data.js', 'builder-config-data.js'):
        head = (ROOT / 'app/public' / generated).read_text().splitlines()[0]
        assert 'do not edit' in head, generated
