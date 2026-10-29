"""scripts/ci-reap-stale.py against a stubbed `gh`: no network, no real runs."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / 'scripts/ci-reap-stale.py'
REPO = 'tuna-os/iso-builder'

# A stand-in `gh` that serves GET listings from a JSON state file, pages them
# like the real API (100 per page) and logs every mutating call.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
assert args[0] == 'api', args
method, rest = 'GET', args[1:]
if rest[0] == '-X':
    method, rest = rest[1], rest[2:]
path = rest[0]
state = json.load(open(os.environ['GH_FAKE_STATE']))
if method != 'GET':
    with open(os.environ['GH_FAKE_LOG'], 'a') as f:
        f.write(f'{method} {path}\n')
    for needle, message in state.get('fail', {}).items():
        if needle in path:
            print(message, file=sys.stderr)
            sys.exit(1)
    sys.exit(0)
if state.get('list_fails') and '/actions/' in path:
    print('gh: HTTP 500: boom', file=sys.stderr)
    sys.exit(1)
if path == 'repos/' + state['repo']:
    print(json.dumps({'default_branch': state['default_branch']}))
else:
    base, _, query = path.partition('?')
    page = int(dict(p.split('=') for p in query.split('&'))['page'])
    key = 'workflow_runs' if base.endswith('/runs') else 'artifacts'
    items = state[key]
    print(json.dumps({'total_count': len(items), key: items[(page - 1) * 100: page * 100]}))
'''

NOW = datetime.now(timezone.utc)
_next_id = iter(range(1000, 10**6))


def stamp(**ago):
    return (NOW - timedelta(**ago)).strftime('%Y-%m-%dT%H:%M:%SZ')


def run(status='completed', wf=1, branch='feature', event='pull_request', **ago):
    rid = next(_next_id)
    return {'id': rid, 'workflow_id': wf, 'name': f'wf{wf}', 'run_number': rid, 'head_branch': branch,
            'event': event, 'status': status, 'created_at': stamp(**ago), 'run_started_at': stamp(**ago),
            'head_repository': {'full_name': REPO}}


def artifact(run_obj, name='qual-x-evidence', expired=True, **ago):
    aid = next(_next_id)
    return {'id': aid, 'name': name, 'expired': expired, 'created_at': stamp(**ago),
            'workflow_run': {'id': run_obj['id']}}


@pytest.fixture
def gh(tmp_path):
    bin_dir = tmp_path / 'bin'
    bin_dir.mkdir()
    fake = bin_dir / 'gh'
    fake.write_text(FAKE_GH)
    fake.chmod(0o755)
    state_file = tmp_path / 'state.json'
    log = tmp_path / 'calls.log'

    class Harness:
        def reap(self, runs=(), artifacts=(), fail=None, list_fails=False, command=None, **env):
            state_file.write_text(json.dumps({
                'repo': REPO, 'default_branch': 'main', 'workflow_runs': list(runs),
                'artifacts': list(artifacts), 'fail': fail or {}, 'list_fails': list_fails}))
            log.write_text('')
            full = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'GH_FAKE_STATE': str(state_file),
                    'GH_FAKE_LOG': str(log), 'GITHUB_REPOSITORY': REPO, 'GITHUB_RUN_ID': '1'}
            for key in ('DRY_RUN', 'STALE_QUEUED_HOURS', 'STALE_RUNNING_HOURS', 'KEEP_RUN_DAYS',
                        'REAP_PROTECTED_BRANCHES', 'REAP_KEEP_ARTIFACT_PREFIXES', 'REPO'):
                full.pop(key, None)
            full.update({k: str(v) for k, v in env.items()})
            self.proc = subprocess.run(command or [sys.executable, str(SCRIPT)], cwd=ROOT, env=full, text=True, capture_output=True)
            return self

        @property
        def calls(self):
            return [line for line in log.read_text().splitlines() if line]

        def cancelled(self):
            return {int(c.split('/runs/')[1].split('/')[0]) for c in self.calls if c.endswith('/cancel')}

        def deleted_runs(self):
            return {int(c.rsplit('/', 1)[1]) for c in self.calls if c.startswith('DELETE') and '/runs/' in c}

        def deleted_artifacts(self):
            return {int(c.rsplit('/', 1)[1]) for c in self.calls if c.startswith('DELETE') and '/artifacts/' in c}

    return Harness()


def newest_guard(branch='feature', wf=1):
    """A fresh completed run so the older ones under test are not the newest of their lane."""
    return run(wf=wf, branch=branch, minutes=1)


def test_cancels_queued_runs_beyond_the_bound_only(gh):
    stuck, fresh = run('queued', hours=9), run('queued', hours=2)
    h = gh.reap([stuck, fresh, newest_guard()])
    assert h.proc.returncode == 0, h.proc.stderr
    assert h.cancelled() == {stuck['id']}
    assert h.deleted_runs() == set()


def test_running_runs_get_a_longer_bound_than_queued_ones(gh):
    eight_hours, thirteen_hours = run('in_progress', hours=8), run('in_progress', hours=13)
    h = gh.reap([eight_hours, thirteen_hours, newest_guard()])
    assert h.cancelled() == {thirteen_hours['id']}
    h = gh.reap([eight_hours, thirteen_hours, newest_guard()], STALE_RUNNING_HOURS=7)
    assert h.cancelled() == {eight_hours['id'], thirteen_hours['id']}


def test_waiting_and_pending_count_as_queued(gh):
    waiting, pending = run('waiting', hours=7), run('pending', hours=7)
    assert gh.reap([waiting, pending, newest_guard()]).cancelled() == {waiting['id'], pending['id']}


def test_never_touches_the_newest_run_per_workflow_and_branch(gh):
    lone_stuck = run('queued', hours=50, branch='lonely')           # newest (and only) run of its lane
    lone_old = run('completed', days=90, branch='retired')          # same, completed
    other_workflow_old = run('completed', wf=2, days=40, branch='feature')  # newest of wf 2 on feature
    old_in_lane = run('completed', days=60, branch='feature')       # superseded in wf 1 / feature
    h = gh.reap([lone_stuck, lone_old, other_workflow_old, old_in_lane, newest_guard()])
    assert h.cancelled() == set()
    assert h.deleted_runs() == {old_in_lane['id']}


def test_runs_from_different_head_repositories_are_different_lanes(gh):
    mine = run('completed', days=40, branch='patch-1')
    fork = run('completed', days=40, branch='patch-1')
    fork['head_repository'] = {'full_name': 'someone/iso-builder'}
    assert gh.reap([mine, fork]).deleted_runs() == set()


def test_deletes_completed_runs_older_than_the_retention_bound(gh):
    old, young, edge = run(days=30), run(days=3), run(days=13)
    h = gh.reap([old, young, edge, newest_guard()])
    assert h.deleted_runs() == {old['id']}
    h = gh.reap([old, young, edge, newest_guard()], KEEP_RUN_DAYS=2)
    assert h.deleted_runs() == {old['id'], young['id'], edge['id']}
    h = gh.reap([old, young, edge, newest_guard()], KEEP_RUN_DAYS=60)
    assert h.deleted_runs() == set()


def test_default_branch_pushes_younger_than_the_bound_are_never_touched(gh):
    young_queued = run('queued', hours=3, branch='main', event='push')
    young_done = run('completed', days=5, branch='main', event='push')
    old_queued = run('queued', hours=9, branch='main', event='push')
    old_done = run('completed', days=30, branch='main', event='push')
    h = gh.reap([young_queued, young_done, old_queued, old_done, newest_guard(branch='main')])
    assert young_queued['id'] not in h.cancelled() and young_done['id'] not in h.deleted_runs()
    assert h.cancelled() == {old_queued['id']} and h.deleted_runs() == {old_done['id']}


def test_never_cancels_its_own_run(gh):
    me = run('in_progress', hours=20)
    me['id'] = 4242
    h = gh.reap([me, newest_guard()], GITHUB_RUN_ID=4242)
    assert h.cancelled() == set()


def test_dry_run_prints_the_plan_and_changes_nothing(gh):
    stuck, old = run('queued', hours=9), run(days=30)
    expired = artifact(old, days=40)
    h = gh.reap([stuck, old, newest_guard()], [expired], DRY_RUN=1)
    assert h.proc.returncode == 0, h.proc.stderr
    assert h.calls == []
    out = h.proc.stdout
    assert f"DRY-RUN cancel {stuck['id']}" in out
    assert f"DRY-RUN delete-run {old['id']}" in out
    assert 'dry run' in out


def test_expired_artifacts_are_deleted_only_when_old_enough(gh):
    keep_run = newest_guard()
    old_expired = artifact(keep_run, days=30)       # belongs to a protected (newest) run: kept
    other = run(days=20)
    other_old_expired = artifact(other, days=20)
    other_young_expired = artifact(other, days=3)
    other_live = artifact(other, expired=False, days=20)
    h = gh.reap([keep_run, other, run(days=1)], [old_expired, other_old_expired, other_young_expired, other_live])
    # `other` is superseded and 20d old, so its run goes; its artifacts go with it, not one by one.
    assert h.deleted_runs() == {other['id']}
    assert h.deleted_artifacts() == set()

    lane_head = run(wf=9, branch='x', minutes=1)
    old_completed_head = run(wf=9, branch='x', days=1)
    stray = artifact(old_completed_head, days=30)
    live = artifact(old_completed_head, expired=False, days=30)
    young = artifact(old_completed_head, days=2)
    h = gh.reap([lane_head, old_completed_head], [stray, live, young])
    assert h.deleted_artifacts() == {stray['id']}


def test_a_run_with_a_live_retained_iso_artifact_is_not_deleted(gh):
    keeper = run(days=30)
    plain = run(days=30)
    iso = artifact(keeper, name='iso-skipjack-gnome-run1-a1', expired=False, days=30)
    manifest = artifact(keeper, name='iso-skipjack-gnome-run1-a1-manifest', expired=False, days=30)
    evidence = artifact(plain, name='browser-evidence-x', expired=False, days=30)
    h = gh.reap([keeper, plain, newest_guard()], [iso, manifest, evidence])
    assert h.deleted_runs() == {plain['id']}
    h = gh.reap([keeper, plain, newest_guard()], [iso, manifest, evidence], REAP_KEEP_ARTIFACT_PREFIXES='')
    assert h.deleted_runs() == {keeper['id'], plain['id']}
    # once the retained artifact has expired, the run is reapable again
    expired_iso = artifact(keeper, name='iso-skipjack-gnome-run1-a1', expired=True, days=30)
    assert gh.reap([keeper, newest_guard()], [expired_iso]).deleted_runs() == {keeper['id']}


def test_lists_every_page(gh):
    runs = [run(days=30, branch='bulk') for _ in range(250)]
    h = gh.reap(runs)
    assert len(h.deleted_runs()) == 249  # all but the newest of the lane
    assert max(r['id'] for r in runs) not in h.deleted_runs()


def test_already_settled_runs_are_not_failures(gh):
    stuck, old = run('queued', hours=9), run(days=30)
    h = gh.reap([stuck, old, newest_guard()], fail={'/cancel': 'gh: HTTP 409: Cannot cancel a run that is completed',
                                                    f"/runs/{old['id']}": 'gh: HTTP 404: Not Found'})
    assert h.proc.returncode == 0, h.proc.stderr


def test_a_real_api_failure_fails_the_job_but_does_not_stop_the_rest(gh):
    stuck, old = run('queued', hours=9), run(days=30)
    h = gh.reap([stuck, old, newest_guard()], fail={'/cancel': 'gh: HTTP 500: server error'})
    assert h.proc.returncode == 1
    assert h.deleted_runs() == {old['id']}
    assert '::warning::' in h.proc.stdout


def test_listing_failure_is_an_error_and_deletes_nothing(gh):
    h = gh.reap([run('queued', hours=9)], list_fails=True)
    assert h.proc.returncode == 1 and h.calls == []


def test_requires_a_repository(gh):
    h = gh.reap([], GITHUB_REPOSITORY='')
    assert h.proc.returncode == 1 and 'GITHUB_REPOSITORY' in h.proc.stderr


# --- just recipe and workflow wiring ----------------------------------------

def test_recipe_forwards_the_environment_to_the_script(gh):
    if shutil.which('just') is None:
        pytest.skip('just not installed')
    stuck = run('queued', hours=9)
    h = gh.reap([stuck, newest_guard()], command=['just', 'ci-reap-stale'], DRY_RUN=1)
    assert h.proc.returncode == 0, h.proc.stderr
    assert h.calls == [] and f"DRY-RUN cancel {stuck['id']}" in h.proc.stdout
    h = gh.reap([stuck, newest_guard()], command=['just', 'ci-reap-stale'])
    assert h.proc.returncode == 0, h.proc.stderr
    assert h.cancelled() == {stuck['id']}




def test_reaper_workflow_is_scheduled_dry_by_default_and_least_privilege():
    wf = yaml.safe_load((ROOT / '.github/workflows/ci-reaper.yml').read_text())
    triggers = wf.get('on') or wf[True]
    assert triggers['schedule'] and 'cron' in triggers['schedule'][0]
    assert triggers['workflow_dispatch']['inputs']['dry_run']['default'] is True
    assert wf['permissions'] == {'contents': 'read'}
    assert wf['concurrency']['cancel-in-progress'] is False
    job = wf['jobs']['reap']
    assert job['permissions'] == {'contents': 'read', 'actions': 'write'}
    step = next(s for s in job['steps'] if 'ci-reap-stale' in s.get('run', ''))
    assert step['run'].strip() == 'just ci-reap-stale'
    # scheduled runs are live; only a dispatch can ask for a dry run
    assert "github.event_name == 'workflow_dispatch' && inputs.dry_run" in step['env']['DRY_RUN']
    assert step['env']['DRY_RUN'].endswith("'0' }}")
