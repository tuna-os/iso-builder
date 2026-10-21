#!/usr/bin/env python3
"""Opt-in, bounded R2 diagnostic retention. No qualification, expiry or deletion.

Uses single-object conditional PUTs for chunks because R2 documents atomic
If-None-Match for PutObject, not for multipart completion. The manifest is the
commit marker and is written only after every remote byte has been verified.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

MAX_ISO_BYTES = 10 * 1024 ** 3
MAX_PROVENANCE_BYTES = 1024 ** 2
CHUNK_BYTES = 64 * 1024 ** 2
MAX_CHUNKS = 160


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def listed_keys(client, bucket, prefix):
    keys, token = set(), None
    while True:
        args = dict(Bucket=bucket, Prefix=prefix)
        if token:
            args['ContinuationToken'] = token
        page = client.list_objects_v2(**args)
        keys.update(obj['Key'] for obj in page.get('Contents', []))
        if not page.get('IsTruncated'):
            return keys
        new_token = page.get('NextContinuationToken')
        if not new_token or new_token == token:
            raise ValueError('invalid object listing pagination')
        token = new_token


def put_new(client, bucket, key, data, content_type):
    # Never fall back to an unconditional write, even on an unsupported header,
    # 412, timeout, or ambiguous response. SDK write retries are disabled in CLI.
    client.put_object(Bucket=bucket, Key=key, Body=data, ContentLength=len(data),
                      ContentType=content_type, IfNoneMatch='*',
                      ContentMD5=base64.b64encode(hashlib.md5(data).digest()).decode())


def read_verified(client, bucket, key, expected_bytes, expected_sha, whole=None, output=None):
    result = client.get_object(Bucket=bucket, Key=key)
    stream = result['Body']
    h, size = hashlib.sha256(), 0
    try:
        if result.get('ContentLength') != expected_bytes:
            raise ValueError('remote object length mismatch')
        while True:
            chunk = stream.read(min(1024 * 1024, expected_bytes + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > expected_bytes:
                raise ValueError('remote object exceeds expected length')
            h.update(chunk)
            if whole is not None:
                whole.update(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        stream.close()
    if size != expected_bytes or h.hexdigest() != expected_sha:
        raise ValueError('remote object SHA-256 mismatch')


def validate_scope(provenance, env):
    if env.get('RETAIN_CANDIDATE') != 'true':
        raise ValueError('explicit candidate retention opt-in is required')
    if (env.get('ONLY') != 'yellowfin-gnome' or env.get('BENCHMARK') != 'false'
            or env.get('KEEP_ISO') != 'false' or env.get('RUN_FULL') != 'true'):
        raise ValueError('retention permits only one non-benchmark Yellowfin GNOME candidate, without release publication')
    if provenance.get('kind') != 'candidate-producer-observations' or provenance.get('qualification') != 'not-assessed':
        raise ValueError('unqualified producer observations required')
    context = provenance.get('producerContext', {})
    if context.get('repository') != 'tuna-os/iso-builder' or context.get('job') != 'full-matrix':
        raise ValueError('unexpected producer context')
    for field, key in [('runId', 'GITHUB_RUN_ID'), ('runAttempt', 'GITHUB_RUN_ATTEMPT')]:
        value = context.get(field, '')
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*', value) or env.get(key) != value:
            raise ValueError('run/attempt binding mismatch')
    iso = provenance.get('iso', {})
    if (type(iso.get('sizeBytes')) is not int or not 0 < iso['sizeBytes'] <= MAX_ISO_BYTES
            or not isinstance(iso.get('sha256'), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', iso['sha256'])):
        raise ValueError('invalid ISO identity or 10 GiB cap exceeded')
    return context, iso


def retain(client, bucket, iso_path, provenance, env, chunk_bytes=CHUNK_BYTES):
    context, iso = validate_scope(provenance, env)
    if not 0 < chunk_bytes <= CHUNK_BYTES:
        raise ValueError('invalid chunk size')
    path = Path(iso_path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != iso['sizeBytes']:
        raise ValueError('candidate must be a regular file matching observed size')
    prefix = (f"browser-iso/candidates/{context['runId']}/{context['runAttempt']}/"
              "yellowfin-gnome/s1/")
    # Compute the entire prospective manifest before any storage write.
    parts, h, scanned = [], hashlib.sha256(), 0
    with path.open('rb') as f:
        while data := f.read(chunk_bytes):
            scanned += len(data)
            if scanned > iso['sizeBytes']:
                raise ValueError('candidate grew beyond observed size')
            h.update(data)
            parts.append({'key': prefix + f'chunks/{len(parts):05d}', 'sizeBytes': len(data),
                          'sha256': hashlib.sha256(data).hexdigest()})
    if h.hexdigest() != iso['sha256'][7:] or sum(p['sizeBytes'] for p in parts) != iso['sizeBytes']:
        raise ValueError('candidate ISO differs from browser observation')
    if len(parts) > MAX_CHUNKS:
        raise ValueError('candidate exceeds maximum chunk count')
    manifest = {'schemaVersion': 1, 'kind': 'retained-browser-candidate',
                'qualification': 'not-assessed', 'state': 'complete', 'expiry': None,
                'warning': 'No automatic expiry. Storage charges may continue until separately authorized removal.',
                'iso': iso, 'chunks': parts, 'provenance': provenance}
    manifest_bytes = encoded(manifest)
    if len(manifest_bytes) > MAX_PROVENANCE_BYTES:
        raise ValueError('manifest and provenance exceed 1 MiB cap')
    if listed_keys(client, bucket, prefix):
        raise ValueError('candidate prefix already exists; no overwrite or resume permitted')
    with path.open('rb') as f:
        for part in parts:
            data = f.read(part['sizeBytes'])
            if len(data) != part['sizeBytes'] or hashlib.sha256(data).hexdigest() != part['sha256']:
                raise ValueError('candidate changed during upload; incomplete chunks may remain')
            put_new(client, bucket, part['key'], data, 'application/octet-stream')
        if f.read(1):
            raise ValueError('candidate grew during upload; incomplete chunks may remain')
    if listed_keys(client, bucket, prefix) != {p['key'] for p in parts}:
        raise ValueError('remote chunk set differs; candidate is incomplete')
    remote_hash = hashlib.sha256()
    for part in parts:
        read_verified(client, bucket, part['key'], part['sizeBytes'], part['sha256'], whole=remote_hash)
    if remote_hash.hexdigest() != iso['sha256'][7:]:
        raise ValueError('remote whole-ISO SHA-256 mismatch')
    key = prefix + 'manifest.json'
    put_new(client, bucket, key, manifest_bytes, 'application/json')
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    read_verified(client, bucket, key, len(manifest_bytes), manifest_hash)
    return {'manifestKey': key, 'manifestSha256': 'sha256:' + manifest_hash,
            'iso': iso, 'chunks': len(parts), 'qualification': 'not-assessed', 'expiry': None}


def restore(client, bucket, manifest_key, output, expected_sha256, expected_manifest_sha256=None):
    if not re.fullmatch(r'browser-iso/candidates/[1-9][0-9]*/[1-9][0-9]*/yellowfin-gnome/s1/manifest\.json', manifest_key):
        raise ValueError('unexpected candidate manifest key')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', expected_sha256):
        raise ValueError('independent expected ISO SHA-256 required')
    if expected_manifest_sha256 is not None and (
            not isinstance(expected_manifest_sha256, str) or
            not re.fullmatch(r'sha256:[0-9a-f]{64}', expected_manifest_sha256)):
        raise ValueError('independent expected manifest SHA-256 is invalid')
    result = client.get_object(Bucket=bucket, Key=manifest_key)
    body = result['Body']
    try:
        if type(result.get('ContentLength')) is not int or not 0 < result['ContentLength'] <= MAX_PROVENANCE_BYTES:
            raise ValueError('manifest exceeds 1 MiB cap')
        data = body.read(MAX_PROVENANCE_BYTES + 1)
        if len(data) != result['ContentLength']:
            raise ValueError('manifest length mismatch')
    finally:
        body.close()
    manifest_hash = 'sha256:' + hashlib.sha256(data).hexdigest()
    if expected_manifest_sha256 is not None and manifest_hash != expected_manifest_sha256:
        raise ValueError('manifest SHA-256 differs from independently expected value')
    manifest = json.loads(data)
    iso, parts = manifest.get('iso', {}), manifest.get('chunks', [])
    if (manifest.get('kind') != 'retained-browser-candidate' or manifest.get('state') != 'complete'
            or manifest.get('qualification') != 'not-assessed' or manifest.get('schemaVersion') != 1
            or iso.get('sha256') != expected_sha256 or type(iso.get('sizeBytes')) is not int
            or not 0 < iso['sizeBytes'] <= MAX_ISO_BYTES or not isinstance(parts, list) or not 1 <= len(parts) <= MAX_CHUNKS):
        raise ValueError('invalid or mismatched candidate manifest')
    prefix = manifest_key.removesuffix('manifest.json')
    provenance = manifest.get('provenance', {})
    context = provenance.get('producerContext', {})
    run_id, run_attempt = manifest_key.split('/')[2:4]
    if (provenance.get('kind') != 'candidate-producer-observations'
            or provenance.get('qualification') != 'not-assessed' or provenance.get('iso') != iso
            or context.get('repository') != 'tuna-os/iso-builder' or context.get('job') != 'full-matrix'
            or context.get('runId') != run_id or context.get('runAttempt') != run_attempt):
        raise ValueError('candidate provenance differs from manifest origin or run')
    for i, part in enumerate(parts):
        if (not isinstance(part, dict) or part.get('key') != prefix + f'chunks/{i:05d}'
                or type(part.get('sizeBytes')) is not int or not 0 < part['sizeBytes'] <= CHUNK_BYTES
                or not isinstance(part.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', part['sha256'])):
            raise ValueError('invalid candidate chunk descriptor')
    if sum(p['sizeBytes'] for p in parts) != iso['sizeBytes']:
        raise ValueError('chunk sizes do not match whole ISO')
    whole = hashlib.sha256()
    # Exclusive create: never overwrite local data. On failure the partial
    # output remains, but the command fails and does not claim reconstruction.
    with Path(output).open('xb') as out:
        for part in parts:
            read_verified(client, bucket, part['key'], part['sizeBytes'], part['sha256'], whole=whole, output=out)
        if whole.hexdigest() != expected_sha256[7:]:
            raise ValueError('restored whole-ISO SHA-256 mismatch; partial output remains')
    return {'restored': str(output), 'iso': iso, 'manifestSha256': manifest_hash,
            'manifestHashChecked': expected_manifest_sha256 is not None, 'qualification': 'not-assessed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path)
    parser.add_argument('--provenance', type=Path)
    parser.add_argument('--restore-manifest')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--expected-manifest-sha256')
    args = parser.parse_args()
    if args.restore_manifest:
        if not args.output or not args.expected_sha256 or args.iso or args.provenance:
            parser.error('restore needs --output and --expected-sha256 only')
    else:
        if not args.iso or not args.provenance or args.output or args.expected_sha256 or args.expected_manifest_sha256:
            parser.error('retention needs --iso and --provenance only')
        if args.provenance.stat().st_size > MAX_PROVENANCE_BYTES:
            raise ValueError('provenance exceeds 1 MiB cap')
        provenance = json.loads(args.provenance.read_text())
        # Fail scope validation before constructing an authenticated client.
        validate_scope(provenance, os.environ)
    import boto3
    from botocore.config import Config
    client = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                          aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                          aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
                          config=Config(retries={'total_max_attempts': 1},
                                        request_checksum_calculation='when_required',
                                        response_checksum_validation='when_required'))
    if 'IfNoneMatch' not in client.meta.service_model.operation_model('PutObject').input_shape.members:
        raise RuntimeError('installed S3 client lacks conditional PutObject; refusing upload')
    if args.restore_manifest:
        result = restore(client, os.environ['R2_BUCKET'], args.restore_manifest, args.output,
                         args.expected_sha256, args.expected_manifest_sha256)
    else:
        result = retain(client, os.environ['R2_BUCKET'], args.iso, provenance, os.environ)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Candidate operation failed. Do not infer completion or retry writes: incomplete remote objects may remain without expiry, or a partial local restore may remain. No objects were deleted.', file=sys.stderr)
        raise
