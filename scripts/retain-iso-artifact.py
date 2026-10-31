#!/usr/bin/env python3
"""Split a browser-built ISO into hash-pinned chunks for a GitHub Actions artifact.

`split` and `verify` use no credentials or network. `split` writes <slug>.iso.partNNNN files plus a
manifest recording the sha256 of the whole ISO and of every chunk, tied to the
browser measurements of the same bytes. `verify` re-reads a downloaded copy,
checks every chunk and the reassembled ISO against that manifest, and can write
the restored ISO. Nothing here qualifies media: the manifest carries the
measurements' own label (`not-assessed` or `diagnostic-unqualified`) and refuses
anything else.
`recover` uses authenticated `gh api` to fetch only run 41153841817's immutable
archives, checking their independently pinned metadata and SHA-256 before extraction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import shutil
import subprocess
import tempfile
import zipfile

MAX_ISO_BYTES = 16 * 1024 ** 3
DEFAULT_CHUNK_BYTES = 2 * 1024 ** 3
MAX_CHUNKS = 64
BLOCK = 8 * 1024 ** 2
LABELS = ('not-assessed', 'diagnostic-unqualified')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')


def fail(message):
    raise SystemExit(f'error: {message}')


def sha(h):
    return f'sha256:{h.hexdigest()}'


def hash_file(path):
    h, size = hashlib.sha256(), 0
    with open(path, 'rb') as f:
        while block := f.read(BLOCK):
            h.update(block)
            size += len(block)
    return sha(h), size


def load_measurements(path, iso_digest, iso_size):
    m = json.loads(Path(path).read_text())
    if m.get('kind') != 'diagnostic-build-measurements' or m.get('schemaVersion') != 1:
        fail('measurements are not diagnostic-build-measurements v1')
    if m.get('qualification') not in LABELS:
        fail(f"measurements qualification must be one of {LABELS}, got {m.get('qualification')!r}")
    iso = m.get('iso') or {}
    if iso.get('sha256') != iso_digest or iso.get('sizeBytes') != iso_size:
        fail('ISO bytes differ from the browser measurements (sha256/size mismatch); refusing to retain')
    for key in ('loadedWasm', 'browser'):
        if not isinstance(m.get(key), dict):
            fail(f'measurements lack {key}')
    if m['qualification'] == 'diagnostic-unqualified' and not isinstance(m.get('diagnosticUnqualified'), dict):
        fail('diagnostic-unqualified measurements lack the diagnosticUnqualified block')
    return m


def split(args):
    iso = Path(args.iso)
    if not SLUG.match(args.slug):
        fail('invalid slug')
    if not 1024 <= args.chunk_bytes:
        fail('chunk size too small')
    digest, size = hash_file(iso)
    if not 0 < size <= MAX_ISO_BYTES:
        fail(f'ISO size {size} outside (0, {MAX_ISO_BYTES}]')
    count = -(-size // args.chunk_bytes)
    if count > MAX_CHUNKS:
        fail(f'{count} chunks exceeds {MAX_CHUNKS}; raise --chunk-bytes')
    m = load_measurements(args.measurements, digest, size)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        fail(f'{out} is not empty')
    chunks, whole = [], hashlib.sha256()
    with open(iso, 'rb') as src:
        for i in range(count):
            name = f'{args.slug}.iso.part{i:04d}'
            h, written, want = hashlib.sha256(), 0, min(args.chunk_bytes, size - i * args.chunk_bytes)
            with open(out / name, 'xb') as dst:
                while written < want:
                    block = src.read(min(BLOCK, want - written))
                    if not block:
                        fail('ISO changed while splitting (short read)')
                    dst.write(block)
                    h.update(block)
                    whole.update(block)
                    written += len(block)
            chunks.append({'name': name, 'offset': i * args.chunk_bytes, 'sizeBytes': written, 'sha256': sha(h)})
        if src.read(1) or sha(whole) != digest:
            fail('ISO changed while splitting (hash differs from the pre-split hash)')
    manifest = {
        'schemaVersion': 1, 'kind': 'candidate-iso-artifact-manifest',
        'qualification': m['qualification'], 'slug': args.slug,
        'iso': {'sha256': digest, 'sizeBytes': size},
        'chunkBytes': args.chunk_bytes, 'chunks': chunks,
        'measurements': {k: m[k] for k in ('iso', 'loadedWasm', 'browser', 'phasesMs', 'diagnosticUnqualified') if k in m},
        'producer': {k: v for k, v in (('repository', args.repository), ('runId', args.run_id),
                                       ('runAttempt', args.run_attempt), ('sha', args.sha)) if v},
        'storage': 'github-actions-artifact', 'r2': False,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps(manifest, indent=2, sort_keys=True))


def verify(args):
    d = Path(args.dir)
    manifest = json.loads((d / args.manifest_name).read_text())
    if manifest.get('kind') != 'candidate-iso-artifact-manifest' or manifest.get('schemaVersion') != 1:
        fail('not a candidate-iso-artifact-manifest v1')
    if manifest.get('qualification') not in LABELS:
        fail('manifest qualification label invalid')
    iso, chunks = manifest['iso'], manifest['chunks']
    if not DIGEST.match(iso['sha256']) or not chunks:
        fail('malformed manifest')
    if args.expected_sha256 and args.expected_sha256 != iso['sha256']:
        fail('manifest ISO sha256 differs from the independently supplied --expected-sha256')
    expected = {c['name'] for c in chunks}
    extra = {p.name for p in d.glob('*.part*')} - expected
    if extra:
        fail(f'unexpected chunk files {sorted(extra)}')
    whole, offset = hashlib.sha256(), 0
    dst = open(args.output, 'xb') if args.output else None
    try:
        for c in chunks:
            if c['offset'] != offset or not SLUG.match(c['name'].split('.iso.part')[0]):
                fail(f"chunk {c['name']} offset/name invalid")
            h, n = hashlib.sha256(), 0
            with open(d / c['name'], 'rb') as f:
                while block := f.read(BLOCK):
                    h.update(block)
                    whole.update(block)
                    n += len(block)
                    if dst:
                        dst.write(block)
            if n != c['sizeBytes'] or sha(h) != c['sha256']:
                fail(f"chunk {c['name']} differs from manifest")
            offset += n
    finally:
        if dst:
            dst.close()
    if offset != iso['sizeBytes'] or sha(whole) != iso['sha256']:
        fail('reassembled ISO differs from manifest')
    print(json.dumps({'verified': True, 'iso': iso, 'chunks': len(chunks), 'qualification': manifest['qualification'],
                      'restored': args.output}, sort_keys=True))


def recover(args):
    """Fetch only the immutable run 41153841817 diagnostic, never rebuild."""
    repository = 'tuna-os/iso-builder'
    run_id = 41153841817
    source_sha = '41cf974098ef5a90c9a73fd3942ed0abeb0c8058'
    archives = (
        (13027183695, 'iso-skipjack-gnome-run41153841817-a1',
         'sha256:057c98786f98d78eaa03edee9c9db48a54499f3a146940a4ffcb4deea79ff04b',
         11452406380, Path(args.dir)),
        (13027593918, 'browser-evidence-skipjack-gnome-run41153841817-a1',
         'sha256:c24cdca4d2eb0866864c8acbb83825951b031a3d9613c462d91731eb157f333e',
         2623, Path(args.evidence_dir)),
    )

    def metadata(path):
        return json.loads(subprocess.check_output(
            ['gh', 'api', f'repos/{repository}/{path}'], text=True))

    def check_run():
        run = metadata(f'actions/runs/{run_id}')
        if not (run.get('id') == run_id and run.get('run_attempt') == 1
                and run.get('head_sha') == source_sha
                and run.get('path') == '.github/workflows/ci.yml'
                and run.get('status') == 'completed' and run.get('conclusion') == 'failure'):
            fail('recovery producer run identity changed')
        return run

    def check_artifact(artifact_id, name, digest, size):
        artifact = metadata(f'actions/artifacts/{artifact_id}')
        producer = artifact.get('workflow_run') or {}
        if not (artifact.get('id') == artifact_id and artifact.get('name') == name
                and artifact.get('digest') == digest and artifact.get('size_in_bytes') == size
                and artifact.get('expired') is False and producer.get('id') == run_id
                and producer.get('head_sha') == source_sha
                and producer.get('repository_id') == 1305022978):
            fail('recovery artifact identity, archive digest, size or expiry changed')
        return artifact

    observations = {'producerBefore': check_run(), 'artifacts': []}
    for artifact_id, name, digest, size, destination in archives:
        before = check_artifact(artifact_id, name, digest, size)
        destination.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='retained-archive-', dir=destination.parent) as scratch:
            archive = Path(scratch) / 'artifact.zip'
            with archive.open('xb') as stream:
                subprocess.run(['gh', 'api', f'repos/{repository}/actions/artifacts/{artifact_id}/zip'],
                               stdout=stream, check=True)
            if hash_file(archive) != (digest, size):
                fail('recovery archive bytes differ from authenticated artifact metadata')
            after = check_artifact(artifact_id, name, digest, size)
            with zipfile.ZipFile(archive) as zipped:
                names = set()
                for member in zipped.infolist():
                    if member.filename in names or member.filename != Path(member.filename).name:
                        fail('recovery archive contains duplicate or nested members')
                    names.add(member.filename)
                    allowed = (member.filename == 'manifest.json' or
                               re.fullmatch(r'skipjack-gnome\.iso\.part[0-9]{4}', member.filename))
                    if artifact_id == 13027593918:
                        allowed = member.filename.endswith('.json') and member.file_size <= 1024 ** 2
                    if not allowed or member.is_dir():
                        fail('unexpected recovery archive member')
                    with zipped.open(member) as src, (destination / member.filename).open('xb') as dst:
                        shutil.copyfileobj(src, dst, BLOCK)
            observations['artifacts'].append({'before': before, 'after': after})
    observations['producerAfter'] = check_run()
    (Path(args.dir) / 'recovery-transport.json').write_text(
        json.dumps(observations, indent=2, sort_keys=True) + '\n')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('split')
    s.add_argument('--iso', required=True)
    s.add_argument('--measurements', required=True)
    s.add_argument('--out', required=True)
    s.add_argument('--slug', required=True)
    s.add_argument('--chunk-bytes', type=int, default=DEFAULT_CHUNK_BYTES)
    s.add_argument('--repository')
    s.add_argument('--run-id')
    s.add_argument('--run-attempt')
    s.add_argument('--sha')
    s.set_defaults(fn=split)
    v = sub.add_parser('verify')
    v.add_argument('--dir', required=True)
    v.add_argument('--manifest-name', default='manifest.json')
    v.add_argument('--output')
    v.add_argument('--expected-sha256', help='independent ISO hash, e.g. from the browser measurements')
    v.set_defaults(fn=verify)
    r = sub.add_parser('recover', help='fetch exact run 41153841817 retained diagnostic archives')
    r.add_argument('--dir', required=True)
    r.add_argument('--evidence-dir', required=True)
    r.set_defaults(fn=recover)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == '__main__':
    main()
