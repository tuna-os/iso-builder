#!/usr/bin/env python3
"""Report copy-pasted code that a change touches. Never fails.

Invoked as `just clone-report`. Runs jscpd with the repository's .jscpd.json
and lists every clone with at least one side in a file the change touched, so
a reviewer sees that the code being edited has a second copy elsewhere.

This is report-only on purpose (#553): clone counts move whenever code moves,
so a failing budget would block unrelated pull requests. Every outcome, including
jscpd or git being unavailable, exits 0.

Environment:
  BASE_SHA        base of the change. Unset, empty or all zeros (a new branch,
                  the weekly schedule, a dispatch) reports every clone.
  HEAD_SHA        head of the change, default HEAD.
  JSCPD_REPORT    read this jscpd JSON report instead of running jscpd.
  GITHUB_STEP_SUMMARY  when set, the report is appended to it as well.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

JSCPD = 'jscpd@4.0.5'
ROOT = Path(__file__).resolve().parents[1]


def changed_files(base, head='HEAD', cwd=ROOT):
    """Paths changed between base and head, or None when that is unknown."""
    if not base or set(base) == {'0'}:
        return None
    r = subprocess.run(['git', 'diff', '--no-renames', '--name-only', f'{base}...{head}'],
                       cwd=cwd, text=True, capture_output=True)
    if r.returncode != 0:
        return None
    return {line for line in r.stdout.splitlines() if line}


def clones_touching(report, changed):
    """Clones from a jscpd JSON report with a side in changed (all when None)."""
    clones = report.get('duplicates') or []
    if changed is None:
        return clones
    return [c for c in clones
            if c['firstFile']['name'] in changed or c['secondFile']['name'] in changed]


def render(clones, changed):
    scope = 'in the repository' if changed is None else f'touching the {len(changed)} changed file(s)'
    lines = [f'### Code clones {scope}: {len(clones)}', '']
    if clones:
        lines.append('Report only; this never fails. Consider changing both copies, or sharing one.')
        lines.append('')
        for c in clones:
            a, b = c['firstFile'], c['secondFile']
            lines.append(f"- `{a['name']}:{a['start']}-{a['end']}` ~ "
                         f"`{b['name']}:{b['start']}-{b['end']}` ({c['format']}, {c['lines']} lines)")
    return '\n'.join(lines) + '\n'


def run_jscpd(out_dir):
    subprocess.run(['npx', '--yes', JSCPD, '--config', '.jscpd.json', '--reporters', 'json',
                    '--output', str(out_dir), '--silent', '.'],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    return json.loads((Path(out_dir) / 'jscpd-report.json').read_text())


def main(env=os.environ):
    try:
        if env.get('JSCPD_REPORT'):
            report = json.loads(Path(env['JSCPD_REPORT']).read_text())
        else:
            with tempfile.TemporaryDirectory() as out:
                report = run_jscpd(out)
    except (OSError, ValueError, subprocess.CalledProcessError) as e:
        print(f'clone-report: no report ({e}); nothing to show', file=sys.stderr)
        return 0
    changed = changed_files(env.get('BASE_SHA', ''), env.get('HEAD_SHA') or 'HEAD')
    text = render(clones_touching(report, changed), changed)
    sys.stdout.write(text)
    if env.get('GITHUB_STEP_SUMMARY'):
        with open(env['GITHUB_STEP_SUMMARY'], 'a') as f:
            f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
