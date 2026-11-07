#!/usr/bin/env python3
"""Replay the frames a strict GUI walkthrough already captured through the CURRENT driver.

A harness-only fix (OCR threshold, state classifier, click-target maths, a new
checkpoint) used to be validated by a full strict dispatch: ~35 min browser
build + ~11 min ISO artifact round trip + 17-100 min guest install, repeated on
every retry. The captured frames in the `full-<slug>-diag` artifact already
hold the evidence the driver decides on, so this replays them in seconds.

What it does: loads `scripts/lib/gnome_installer_driver.py` from a tunaOS
checkout, then runs the driver's own `drive()` with a `capture` that hands back
the recorded frame files in order, a `pointer` that always acknowledges, and no
sleeping. Every frame is re-OCR'd and re-classified by the code under test and
compared with the state the original run recorded in walkthrough-gnome.json.

What it cannot do: the guest is not running, so a click that would now land
somewhere new produces no new frame. The replay therefore proves "the current
driver reads these frames the way the recorded run did (or the way you now
expect)", never "the install works". Password-entry captures are private by
design (never retained), so a LUKS replay stops at the first one and says so.

  replay-strict-frames.py DIR [--harness-root tunaos-e2e-current]
                              [--text-only] [--expect same|progress] [--json OUT]

DIR is a `walkthrough-<mode>` directory or any parent (an unzipped diag artifact).
--text-only skips PNGs and re-runs only classify() over the recorded OCR lines:
instant, no tesseract/ImageMagick, validates classifier changes. Frames whose state
comes from a pixel panel check (progress, done) are reported `needs-png`, not judged.
Exit 0: every replayed frame matches (or, with --expect progress, the replay got
at least as far as the recorded run). 1: mismatch. 2: bad input.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
from pathlib import Path


def load_driver(root: Path):
    path = root / 'scripts/lib/gnome_installer_driver.py'
    if not path.is_file():
        print(f'2: no driver at {path} (pass --harness-root)', file=sys.stderr)
        raise SystemExit(2)
    spec = importlib.util.spec_from_file_location('gnome_installer_driver', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_walkthroughs(root: Path):
    return sorted(root.rglob('walkthrough-gnome.json'))


def replay_text(driver, evidence):
    rows = []
    for index, frame in enumerate(evidence['frames']):
        if frame.get('private') or 'text' not in frame:
            rows.append((index, frame.get('file', '<private>'), frame['state'], None, 'not-retained'))
            break
        if frame['state'] in ('progress', 'done'):
            # Set by the pixel/OCR panel checks in Screen, not by classify(): needs the PNG.
            rows.append((index, frame['file'], frame['state'], None, 'needs-png'))
            continue
        state = driver.classify(frame['text'])
        rows.append((index, frame['file'], frame['state'], state, 'ok' if state == frame['state'] else 'MISMATCH'))
    return rows, None


def replay_frames(driver, frames_dir: Path, evidence):
    recorded = list(evidence['frames'])

    class ReplayStop(driver.Unverified):
        pass

    queue = iter(recorded)

    def capture(counter, label, directory=None):
        frame = next(queue, None)
        if frame is None:
            raise ReplayStop('recorded frames exhausted')
        if frame.get('private') or 'file' not in frame:
            raise ReplayStop('next recorded frame is a private password-entry capture (never retained)')
        path = frames_dir / frame['file']
        if not path.is_file():
            raise ReplayStop(f'recorded frame missing from artifact: {frame["file"]}')
        return str(path)

    clock_ticks = iter(range(10 ** 9))
    with tempfile.TemporaryDirectory(prefix='strict-replay-') as out:
        code = driver.drive(
            out, evidence['mode'], '/nonexistent-vnc-socket', capture,
            lambda *keys: None, lambda text: None, evidence['installer_digest'],
            'replay-passphrase-0' if evidence['mode'] == 'luks' else 'unused-in-plain',
            evidence['source_ref'], sleep=lambda seconds: None, pointer=lambda *a: True,
            clock=lambda: next(clock_ticks) * 0.001)
        replayed = json.loads((Path(out) / 'walkthrough-gnome.json').read_text())
    rows = []
    for index, old in enumerate(recorded):
        new = replayed['frames'][index] if index < len(replayed['frames']) else None
        if new is None:
            rows.append((index, old.get('file', '<private>'), old['state'], None, 'not-reached'))
        else:
            rows.append((index, old.get('file', '<private>'), old['state'], new['state'],
                         'ok' if new['state'] == old['state'] else 'MISMATCH'))
    return rows, (code, replayed.get('error'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('path', type=Path)
    parser.add_argument('--harness-root', type=Path, default=Path('tunaos-e2e-current'))
    parser.add_argument('--text-only', action='store_true')
    parser.add_argument('--expect', choices=('same', 'progress'), default='same')
    parser.add_argument('--json', type=Path)
    args = parser.parse_args(argv)

    walkthroughs = find_walkthroughs(args.path)
    if not walkthroughs:
        print(f'2: no walkthrough-gnome.json under {args.path}', file=sys.stderr)
        return 2
    driver = load_driver(args.harness_root.absolute())
    failed = False
    report = []
    judged = 0
    for manifest in walkthroughs:
        evidence = json.loads(manifest.read_text())
        if not str(evidence.get('driver', '')).startswith('gnome'):
            print(f'skip {manifest}: driver {evidence.get("driver")!r} is not the GNOME driver')
            continue
        if args.text_only:
            rows, outcome = replay_text(driver, evidence)
        elif not all(evidence.get(key) for key in ('mode', 'installer_digest', 'source_ref')):
            print(f'skip {manifest}: recorded by an older driver (no installer_digest/source_ref); use --text-only')
            continue
        else:
            rows, outcome = replay_frames(driver, manifest.parent, evidence)
        mismatches = [r for r in rows if r[4] == 'MISMATCH']
        print(f'== {manifest.parent} mode={evidence["mode"]} recorded error: {evidence.get("error")!r}')
        for index, name, old, new, status in rows:
            print(f'  {index:3} {name:28} recorded={old:10} replay={new if new else "-":10} {status}')
        if outcome:
            print(f'  replay verdict: exit={outcome[0]} error={outcome[1]!r}')
        judged += 1
        reached = sum(1 for r in rows if r[3] is not None)
        if args.expect == 'same':
            ok = not mismatches
        else:
            ok = not mismatches and reached >= sum(1 for r in rows if r[4] not in ('not-retained', 'needs-png'))
        failed |= not ok
        report.append({'walkthrough': str(manifest), 'mode': evidence['mode'], 'frames': len(rows),
                       'replayed': reached, 'mismatches': len(mismatches),
                       'recorded_error': evidence.get('error'),
                       'replay_error': outcome[1] if outcome else None})
    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + '\n')
    if not judged:
        print('2: nothing replayable under ' + str(args.path), file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
