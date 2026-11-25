"""#447: hosted runners reclaim disk between the browser build and the strict guest."""
from pathlib import Path

import yaml

CI = Path(__file__).parents[1] / '.github/workflows/ci.yml'


def steps():
    wf = yaml.safe_load(CI.read_text())
    return wf['jobs']['full-matrix']['steps']


def test_reclaim_runs_after_build_before_roundtrip_and_skips_karnataka():
    s = steps()
    names = [x.get('name') for x in s]
    i = names.index('free hosted-runner disk before round trip and guest')
    assert names.index('upload ISO chunks') < i < names.index('download ISO artifact again')
    step = s[i]
    assert "!= 'karnataka-gpu'" in step['if']
    assert 'RUNNER_TEMP' not in step['run'] and '_temp' not in step['run']
