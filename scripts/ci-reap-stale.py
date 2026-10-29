#!/usr/bin/env python3
"""Reap stale GitHub Actions runs and artifacts through `gh api`.

Invoked as `just ci-reap-stale` by .github/workflows/ci-reaper.yml (daily and
on dispatch). Three actions, all through the REST API:

  cancel   runs that are still queued/waiting for STALE_QUEUED_HOURS, or still
           in progress for STALE_RUNNING_HOURS. A queued run has no business
           outliving a day's runner pool; the in-progress bound is larger than
           the 6 h hosted-job maximum plus a nine-cell full-matrix sweep, so a
           legitimate run is never cancelled.
  delete   completed runs created more than KEEP_RUN_DAYS ago.
  delete   artifacts that are already expired and were created more than
           KEEP_RUN_DAYS ago (their bytes are gone; this drops the record).

Never touched, whatever their age:
  * the newest run of each workflow + branch (+ head repository), so the
    latest result of every lane stays inspectable;
  * the reaper's own run (GITHUB_RUN_ID);
  * a push to the default branch (or REAP_PROTECTED_BRANCHES) whose creation
    time is younger than the bound being applied;
  * a completed run that still owns an unexpired artifact whose name starts
    with one of REAP_KEEP_ARTIFACT_PREFIXES (default `iso-`): those are the
    deliberately retained diagnostic ISOs, kept for 1-90 days by the person
    who dispatched the run, and deleting the run would delete them too.

Environment:
  GITHUB_REPOSITORY / REPO   owner/name (required)
  GH_TOKEN                   token with actions: write
  STALE_QUEUED_HOURS         default 6
  STALE_RUNNING_HOURS        default max(STALE_QUEUED_HOURS, 12)
  KEEP_RUN_DAYS              default 14
  REAP_PROTECTED_BRANCHES    extra comma-separated protected branches
  REAP_KEEP_ARTIFACT_PREFIXES  comma-separated, default `iso-`
  REAP_MAX_PAGES             listing page cap (100 items/page), default 30
  DRY_RUN=1                  print the plan, change nothing
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

QUEUED_STATES = {'queued', 'waiting', 'requested', 'pending'}
RUNNING_STATES = {'in_progress'}
PAGE = 100


class GhError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def gh_api(path, method='GET'):
    cmd = ['gh', 'api', '-X', method, path] if method != 'GET' else ['gh', 'api', path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        text = (proc.stderr or proc.stdout).strip()
        status = None
        for code in ('404', '409', '422'):
            if f'HTTP {code}' in text:
                status = int(code)
        raise GhError(f'gh api {method} {path}: {text}', status)
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def parse_time(value):
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


def paged(path_template, key, max_pages):
    items = []
    for page in range(1, max_pages + 1):
        data = gh_api(path_template.format(page=page)) or {}
        batch = data.get(key, [])
        items.extend(batch)
        if len(batch) < PAGE:
            break
    return items


def config(env):
    queued = float(env.get('STALE_QUEUED_HOURS') or 6)
    running = float(env.get('STALE_RUNNING_HOURS') or max(queued, 12))
    return {
        'queued': timedelta(hours=queued),
        'running': timedelta(hours=running),
        'keep': timedelta(days=float(env.get('KEEP_RUN_DAYS') or 14)),
        'own_run': env.get('GITHUB_RUN_ID', ''),
        'protected': {b for b in (env.get('REAP_PROTECTED_BRANCHES') or '').split(',') if b},
        'prefixes': tuple(p for p in (env.get('REAP_KEEP_ARTIFACT_PREFIXES', 'iso-')).split(',') if p),
    }


def _key(run):
    head = (run.get('head_repository') or {}).get('full_name')
    return (run.get('workflow_id'), run.get('head_branch'), head)


def decide(runs, artifacts, now, cfg, default_branch):
    """Pure policy. Returns a list of (action, id, description) in apply order."""
    newest = {}
    for run in runs:
        k = _key(run)
        rank = (run['created_at'], run['id'])
        if k not in newest or rank > (newest[k]['created_at'], newest[k]['id']):
            newest[k] = run
    newest_ids = {r['id'] for r in newest.values()}
    protected_branches = cfg['protected'] | ({default_branch} if default_branch else set())

    live_kept = set()
    for art in artifacts:
        run_id = (art.get('workflow_run') or {}).get('id')
        if run_id and not art.get('expired') and art['name'].startswith(cfg['prefixes']):
            live_kept.add(run_id)

    def protected_push_younger(run, bound):
        return (run.get('event') == 'push' and run.get('head_branch') in protected_branches
                and now - parse_time(run['created_at']) < bound)

    actions, doomed = [], set()
    for run in sorted(runs, key=lambda r: (r['created_at'], r['id'])):
        rid = run['id']
        if str(rid) == cfg['own_run'] or rid in newest_ids:
            continue
        label = f"{run.get('name') or run.get('workflow_id')} #{run.get('run_number')} on {run.get('head_branch')}"
        status = run.get('status')
        if status in QUEUED_STATES | RUNNING_STATES:
            queued = status in QUEUED_STATES
            bound = cfg['queued'] if queued else cfg['running']
            started = parse_time(run.get('run_started_at') or run['created_at'])
            age = now - started
            if age >= bound and not protected_push_younger(run, bound):
                actions.append(('cancel', rid, f'{label} {status} for {age.total_seconds() / 3600:.1f}h'))
        elif status == 'completed':
            age = now - parse_time(run['created_at'])
            if age < cfg['keep'] or protected_push_younger(run, cfg['keep']):
                continue
            if rid in live_kept:
                continue
            actions.append(('delete-run', rid, f'{label} completed, {age.days}d old'))
            doomed.add(rid)

    for art in sorted(artifacts, key=lambda a: a['id']):
        run_id = (art.get('workflow_run') or {}).get('id')
        if not art.get('expired') or run_id in doomed or run_id in newest_ids:
            continue
        age = now - parse_time(art['created_at'])
        if age >= cfg['keep']:
            actions.append(('delete-artifact', art['id'], f"{art['name']} expired, {age.days}d old"))
    return actions


def apply(repo, actions, dry):
    failures = 0
    for kind, ident, desc in actions:
        print(f"{'DRY-RUN ' if dry else ''}{kind} {ident}: {desc}")
        if dry:
            continue
        try:
            if kind == 'cancel':
                gh_api(f'repos/{repo}/actions/runs/{ident}/cancel', 'POST')
            elif kind == 'delete-run':
                gh_api(f'repos/{repo}/actions/runs/{ident}', 'DELETE')
            else:
                gh_api(f'repos/{repo}/actions/artifacts/{ident}', 'DELETE')
        except GhError as e:
            if e.status in (404, 409):  # finished or gone in the meantime
                print(f'  already settled: {e}')
            else:
                failures += 1
                print(f'::warning::{e}')
    return failures


def main(env=None, now=None):
    env = dict(os.environ if env is None else env)
    repo = env.get('REPO') or env.get('GITHUB_REPOSITORY')
    if not repo or '/' not in repo:
        print('::error::ci-reap-stale: set GITHUB_REPOSITORY (owner/name)', file=sys.stderr)
        return 1
    dry = env.get('DRY_RUN', '') not in ('', '0', 'false')
    cfg = config(env)
    now = now or datetime.now(timezone.utc)
    max_pages = int(env.get('REAP_MAX_PAGES') or 30)
    try:
        default_branch = (gh_api(f'repos/{repo}') or {}).get('default_branch')
        runs = paged(f'repos/{repo}/actions/runs?per_page={PAGE}&page={{page}}', 'workflow_runs', max_pages)
        artifacts = paged(f'repos/{repo}/actions/artifacts?per_page={PAGE}&page={{page}}', 'artifacts', max_pages)
    except GhError as e:
        print(f'::error::ci-reap-stale: {e}', file=sys.stderr)
        return 1
    actions = decide(runs, artifacts, now, cfg, default_branch)
    print(f'ci-reap-stale {repo}: {len(runs)} runs, {len(artifacts)} artifacts, '
          f'{len(actions)} action(s){" (dry run)" if dry else ""}; default branch {default_branch}')
    failures = apply(repo, actions, dry)
    summary = env.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as f:
            f.write(f'### ci-reap-stale{" (dry run)" if dry else ""}\n\n'
                    f'{len(actions)} action(s): ' + ', '.join(
                        f'{k}={sum(1 for a in actions if a[0] == k)}'
                        for k in ('cancel', 'delete-run', 'delete-artifact')) + '\n')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
