"""The strict-frame replay feeds recorded frames to the harness driver and compares states."""
import importlib.util
import json
import textwrap
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('replay', ROOT / 'scripts/replay-strict-frames.py')
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

# A stand-in for tunaOS scripts/lib/gnome_installer_driver.py: classify() by keyword, and a
# drive() that observes every capture() the way the real one does and records the states.
DRIVER = textwrap.dedent('''
    import json
    from pathlib import Path

    class Unverified(RuntimeError):
        pass

    def classify(lines):
        text = ' '.join(lines).lower()
        for state in ('failed', 'summary', 'encryption', 'welcome'):
            if state in text:
                return state
        return 'unknown'

    def drive(outdir, mode, vnc, capture, keys, type_text, installer_digest, password, source_ref,
              sleep=None, pointer=None, clock=None):
        evidence = {'frames': []}
        code = 0
        try:
            for index in range(8):
                path = capture(index, 'x')
                evidence['frames'].append({'file': Path(path).name, 'state': Path(path).read_text().strip()})
        except Unverified as exc:
            evidence['error'] = str(exc)
            code = 1
        Path(outdir, 'walkthrough-gnome.json').write_text(json.dumps(evidence))
        return code
''')


def artifact(tmp_path, states, private_at=None):
    harness = tmp_path / 'harness/scripts/lib'
    harness.mkdir(parents=True)
    (harness / 'gnome_installer_driver.py').write_text(DRIVER)
    run = tmp_path / 'diag/walkthrough-plain'
    run.mkdir(parents=True)
    frames = []
    for index, state in enumerate(states):
        if index == private_at:
            frames.append({'state': state, 'private': True})
            continue
        name = f'frame-{index:02d}.png'
        (run / name).write_text(state)
        frames.append({'file': name, 'state': state, 'text': [state]})
    (run / 'walkthrough-gnome.json').write_text(json.dumps({
        'driver': 'gnome-test', 'mode': 'plain', 'installer_digest': 'sha256:x',
        'source_ref': 'tuna-os/skipjack:gnome', 'frames': frames, 'error': 'invalid installer state: failed'}))
    return tmp_path / 'harness', tmp_path / 'diag'


def test_text_only_flags_a_frame_the_current_classifier_reads_differently(tmp_path, capsys):
    harness, diag = artifact(tmp_path, ['welcome', 'encryption', 'summary'])
    manifest = diag / 'walkthrough-plain/walkthrough-gnome.json'
    data = json.loads(manifest.read_text())
    data['frames'][1]['text'] = ['something the new classifier cannot place']
    manifest.write_text(json.dumps(data))
    assert replay.main([str(diag), '--harness-root', str(harness), '--text-only']) == 1
    assert 'MISMATCH' in capsys.readouterr().out


def test_full_replay_passes_when_the_driver_reads_every_recorded_frame_the_same(tmp_path):
    harness, diag = artifact(tmp_path, ['welcome', 'encryption', 'summary', 'failed'])
    out = tmp_path / 'report.json'
    assert replay.main([str(diag), '--harness-root', str(harness), '--json', str(out)]) == 0
    report = json.loads(out.read_text())[0]
    assert report['frames'] == 4 and report['replayed'] == 4 and report['mismatches'] == 0


def test_private_password_frames_stop_the_replay_without_failing_it(tmp_path, capsys):
    harness, diag = artifact(tmp_path, ['welcome', 'encryption', 'encryption', 'summary'], private_at=2)
    assert replay.main([str(diag), '--harness-root', str(harness)]) == 0
    assert 'private password-entry capture' in capsys.readouterr().out


def test_nothing_to_replay_is_an_input_error(tmp_path):
    harness, _ = artifact(tmp_path, ['welcome'])
    assert replay.main([str(tmp_path / 'empty'), '--harness-root', str(harness)]) == 2
