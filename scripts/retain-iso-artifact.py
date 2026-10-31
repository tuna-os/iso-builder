#!/usr/bin/env python3
"""Split a browser-built ISO into hash-pinned chunks for a GitHub Actions artifact.

No credentials, no network. `split` writes <slug>.iso.partNNNN files plus a
manifest recording the sha256 of the whole ISO and of every chunk, tied to the
browser measurements of the same bytes. `verify` re-reads a downloaded copy,
checks every chunk and the reassembled ISO against that manifest, and can write
the restored ISO. Nothing here qualifies media: the manifest carries the
measurements' own label (`not-assessed` or `diagnostic-unqualified`) and refuses
anything else.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

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


def validate_diagnostic_context(qualification, measurements, diagnostic_unqualified):
    expected = 'diagnostic-unqualified' if diagnostic_unqualified else 'not-assessed'
    if qualification != expected:
        fail('qualification differs from --diagnostic-unqualified context')
    diagnostic = measurements.get('diagnosticUnqualified')
    if diagnostic_unqualified:
        if not isinstance(diagnostic, dict) or diagnostic.get('label') != 'diagnostic, unqualified build':
            fail('diagnostic-unqualified measurements lack the diagnosticUnqualified label')
    elif 'diagnosticUnqualified' in measurements:
        fail('non-diagnostic measurements contain a diagnosticUnqualified block')


def load_measurements(path, iso_digest, iso_size, diagnostic_unqualified=False):
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
    validate_diagnostic_context(m['qualification'], m, diagnostic_unqualified)
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
    m = load_measurements(args.measurements, digest, size, args.diagnostic_unqualified == 'true')
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
    measurements = manifest.get('measurements')
    if not isinstance(measurements, dict):
        fail('manifest measurements missing')
    validate_diagnostic_context(manifest['qualification'], measurements, args.diagnostic_unqualified == 'true')
    if measurements.get('iso') != manifest.get('iso'):
        fail('manifest measurements differ from the retained ISO')
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
    s.add_argument('--diagnostic-unqualified', choices=('true', 'false'), default='false')
    s.set_defaults(fn=split)
    v = sub.add_parser('verify')
    v.add_argument('--dir', required=True)
    v.add_argument('--manifest-name', default='manifest.json')
    v.add_argument('--output')
    v.add_argument('--expected-sha256', help='independent ISO hash, e.g. from the browser measurements')
    v.add_argument('--diagnostic-unqualified', choices=('true', 'false'), default='false')
    v.set_defaults(fn=verify)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == '__main__':
    main()
