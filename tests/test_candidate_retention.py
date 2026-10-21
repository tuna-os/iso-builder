"""Tiny in-memory storage fixtures, never real R2 writes or boot evidence."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'scripts/retain-browser-candidate.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Storage:
    def __init__(self):
        self.objects, self.writes = {}, []
        self.fail_at = None
        self.corrupt_key = None
        self.race_at = None
        self.ambiguous_at = None

    def list_objects_v2(self, **args):
        return {'Contents': [{'Key': k} for k in self.objects if k.startswith(args['Prefix'])]}

    def put_object(self, **args):
        key = args['Key']
        assert args['IfNoneMatch'] == '*'
        assert args['ContentLength'] == len(args['Body'])
        assert set(args) == {'Bucket', 'Key', 'Body', 'ContentLength', 'ContentType', 'IfNoneMatch', 'ContentMD5'}
        self.writes.append(key)
        if self.race_at == len(self.writes):
            self.objects[key] = b'concurrent object'
        if key in self.objects:
            raise RuntimeError('412 PreconditionFailed')
        if self.fail_at == len(self.writes):
            raise RuntimeError('network error; do not retry')
        self.objects[key] = args['Body']
        if self.ambiguous_at == len(self.writes):
            raise RuntimeError('connection lost after write; outcome uncertain')

    def get_object(self, **args):
        data = self.objects[args['Key']]
        if self.corrupt_key and self.corrupt_key in args['Key']:
            data = b'x' * len(data)
        return {'Body': io.BytesIO(data), 'ContentLength': len(data)}


@pytest.fixture
def candidate(tmp_path):
    path = tmp_path / 'candidate.iso'
    path.write_bytes(b'tiny unbootable fixture')
    identity = {'sizeBytes': path.stat().st_size, 'sha256': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
    provenance = {'kind': 'candidate-producer-observations', 'qualification': 'not-assessed', 'iso': identity,
                  'producerContext': {'repository': 'tuna-os/iso-builder', 'job': 'full-matrix', 'runId': '123', 'runAttempt': '1'}}
    env = dict(RETAIN_CANDIDATE='true', ONLY='yellowfin-gnome', BENCHMARK='false', KEEP_ISO='false',
               RUN_FULL='true', GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1')
    return Storage(), 'fixture-bucket', path, provenance, env


def test_commit_last_after_complete_verified_chunks(candidate):
    client, _, path, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    assert client.writes[-1].endswith('/manifest.json')
    manifest = json.loads(client.objects[client.writes[-1]])
    assert manifest['state'] == 'complete'
    assert manifest['qualification'] == 'not-assessed'
    assert manifest['expiry'] is None
    assert result['iso'] == provenance['iso']
    assert b''.join(client.objects[p['key']] for p in manifest['chunks']) == path.read_bytes()
    assert sum(len(x) for x in client.objects.values()) <= path.stat().st_size + m.MAX_PROVENANCE_BYTES
    assert all(k.startswith('browser-iso/candidates/123/1/yellowfin-gnome/s1/') for k in client.writes)
    assert not any('latest' in k or 'live-isos/' in k for k in client.writes)


@pytest.mark.parametrize('key,value', [('RETAIN_CANDIDATE', 'false'), ('ONLY', ''), ('ONLY', 'bonito-kde'),
    ('ONLY', 'yellowfin-gnome,bonito-kde'), ('BENCHMARK', 'true'), ('KEEP_ISO', 'true'), ('RUN_FULL', 'false'),
    ('GITHUB_RUN_ID', 'other'), ('GITHUB_RUN_ATTEMPT', '2')])
def test_scope_rejected_before_write(candidate, key, value):
    candidate[4][key] = value
    with pytest.raises(ValueError):
        m.retain(*candidate, chunk_bytes=8)
    assert candidate[0].writes == []


def test_size_cap_before_write(candidate):
    candidate[3]['iso']['sizeBytes'] = m.MAX_ISO_BYTES + 1
    with pytest.raises(ValueError, match='cap'):
        m.retain(*candidate)
    assert candidate[0].writes == []


def test_metadata_cap_before_write(candidate):
    candidate[3]['extra'] = 'x' * m.MAX_PROVENANCE_BYTES
    with pytest.raises(ValueError, match='1 MiB'):
        m.retain(*candidate)
    assert candidate[0].writes == []


def test_wrong_iso_hash_before_write(candidate):
    candidate[3]['iso']['sha256'] = 'sha256:' + 'a' * 64
    with pytest.raises(ValueError, match='differs'):
        m.retain(*candidate)
    assert candidate[0].writes == []


def test_existing_candidate_refused_without_write(candidate):
    m.retain(*candidate, chunk_bytes=8)
    count = len(candidate[0].writes)
    before = dict(candidate[0].objects)
    with pytest.raises(ValueError, match='already exists'):
        m.retain(*candidate, chunk_bytes=8)
    assert candidate[0].objects == before
    assert len(candidate[0].writes) == count


@pytest.mark.parametrize('index', [1, 2, 4])
def test_write_failure_never_marks_complete_or_retries(candidate, index):
    candidate[0].fail_at = index
    with pytest.raises(RuntimeError):
        m.retain(*candidate, chunk_bytes=8)
    assert len(candidate[0].writes) == index
    assert not any(k.endswith('manifest.json') for k in candidate[0].objects)


def test_atomic_conflict_does_not_overwrite(candidate):
    candidate[0].race_at = 1
    with pytest.raises(RuntimeError, match='412'):
        m.retain(*candidate, chunk_bytes=8)
    assert list(candidate[0].objects.values()) == [b'concurrent object']
    assert len(candidate[0].writes) == 1


def test_remote_same_size_corruption_blocks_manifest(candidate):
    candidate[0].corrupt_key = 'chunks/00001'
    with pytest.raises(ValueError, match='SHA-256'):
        m.retain(*candidate, chunk_bytes=8)
    assert not any(k.endswith('manifest.json') for k in candidate[0].objects)


def test_symlink_iso_rejected(candidate, tmp_path):
    client, bucket, path, provenance, env = candidate
    link = tmp_path / 'link.iso'
    link.symlink_to(path)
    with pytest.raises(ValueError, match='regular'):
        m.retain(client, bucket, link, provenance, env)
    assert client.writes == []


def test_second_different_iso_in_same_run_attempt_refused(candidate):
    client, bucket, path, provenance, env = candidate
    m.retain(*candidate, chunk_bytes=8)
    count = len(client.writes)
    path.write_bytes(b'new different candidate')
    provenance['iso'] = {'sha256': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest(), 'sizeBytes': path.stat().st_size}
    with pytest.raises(ValueError, match='already exists'):
        m.retain(*candidate, chunk_bytes=8)
    assert len(client.writes) == count


def test_restore_reconstructs_exact_iso(candidate, tmp_path):
    client, bucket, path, provenance, env = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    output = tmp_path / 'restored.iso'
    m.restore(client, bucket, result['manifestKey'], output, provenance['iso']['sha256'])
    assert output.read_bytes() == path.read_bytes()
    with pytest.raises(FileExistsError):
        m.restore(client, bucket, result['manifestKey'], output, provenance['iso']['sha256'])


def test_restore_requires_independently_expected_sha(candidate, tmp_path):
    client, bucket, _, _, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    output = tmp_path / 'restored.iso'
    with pytest.raises(ValueError, match='mismatched'):
        m.restore(client, bucket, result['manifestKey'], output, 'sha256:' + '0' * 64)
    assert not output.exists()


def test_restore_refuses_cross_prefix_chunk(candidate, tmp_path):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    key = result['manifestKey']
    manifest = json.loads(client.objects[key])
    manifest['chunks'][0]['key'] = 'live-isos/something.iso'
    client.objects[key] = m.encoded(manifest)
    with pytest.raises(ValueError, match='descriptor'):
        m.restore(client, bucket, key, tmp_path / 'restored.iso', provenance['iso']['sha256'])


def test_restore_corruption_fails_and_leaves_partial_output(candidate, tmp_path):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    client.corrupt_key = 'chunks/00001'
    output = tmp_path / 'restored.iso'
    with pytest.raises(ValueError, match='SHA-256'):
        m.restore(client, bucket, result['manifestKey'], output, provenance['iso']['sha256'])
    assert output.exists()


@pytest.mark.parametrize('index', [1, 4])
def test_ambiguous_write_preserves_failure_without_retry_or_delete(candidate, index):
    client = candidate[0]
    client.ambiguous_at = index
    with pytest.raises(RuntimeError, match='uncertain'):
        m.retain(*candidate, chunk_bytes=8)
    assert len(client.writes) == index
    assert len(client.objects) == index
    # A commit marker can exist after a lost response; the caller still fails.
    assert any(k.endswith('manifest.json') for k in client.objects) == (index == 4)


def test_restore_altered_chunk_hash_still_fails_independent_whole_hash(candidate, tmp_path):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    key = result['manifestKey']
    manifest = json.loads(client.objects[key])
    part = manifest['chunks'][0]
    changed = b'x' * part['sizeBytes']
    client.objects[part['key']] = changed
    part['sha256'] = hashlib.sha256(changed).hexdigest()
    client.objects[key] = m.encoded(manifest)
    with pytest.raises(ValueError, match='whole-ISO'):
        m.restore(client, bucket, key, tmp_path / 'restored.iso', provenance['iso']['sha256'])


def test_manifest_hash_binds_exact_retained_metadata(candidate, tmp_path):
    client, bucket, path, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    raw = client.objects[result['manifestKey']]
    assert result['manifestSha256'] == 'sha256:' + hashlib.sha256(raw).hexdigest()
    restored = m.restore(client, bucket, result['manifestKey'], tmp_path / 'exact.iso',
                         provenance['iso']['sha256'], result['manifestSha256'])
    assert restored['manifestHashChecked'] is True
    assert restored['manifestSha256'] == result['manifestSha256']
    assert (tmp_path / 'exact.iso').read_bytes() == path.read_bytes()
    assert restored['qualification'] == 'not-assessed'


def test_manifest_metadata_swap_fails_before_output_creation(candidate, tmp_path):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    manifest = json.loads(client.objects[result['manifestKey']])
    manifest['warning'] = 'changed metadata with identical ISO and chunks'
    client.objects[result['manifestKey']] = m.encoded(manifest)
    output = tmp_path / 'swapped.iso'
    with pytest.raises(ValueError, match='manifest SHA-256'):
        m.restore(client, bucket, result['manifestKey'], output,
                  provenance['iso']['sha256'], result['manifestSha256'])
    assert not output.exists()


@pytest.mark.parametrize('field,value', [
    ('repository', 'other/iso-builder'), ('job', 'deploy'),
    ('runId', '456'), ('runAttempt', '2'),
])
def test_restore_rejects_wrong_producer_context_even_with_matching_iso(candidate, tmp_path, field, value):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    manifest = json.loads(client.objects[result['manifestKey']])
    manifest['provenance']['producerContext'][field] = value
    client.objects[result['manifestKey']] = m.encoded(manifest)
    output = tmp_path / 'wrong-origin.iso'
    with pytest.raises(ValueError, match='origin or run'):
        m.restore(client, bucket, result['manifestKey'], output, provenance['iso']['sha256'])
    assert not output.exists()


def test_legacy_restore_does_not_claim_expected_manifest_check(candidate, tmp_path):
    client, bucket, _, provenance, _ = candidate
    result = m.retain(*candidate, chunk_bytes=8)
    restored = m.restore(client, bucket, result['manifestKey'], tmp_path / 'legacy.iso', provenance['iso']['sha256'])
    assert restored['manifestHashChecked'] is False
    assert restored['qualification'] == 'not-assessed'


@pytest.mark.parametrize('bad', ['', 'main', 'sha256:' + 'A' * 64, True])
def test_invalid_manifest_digest_fails_before_storage_read(candidate, tmp_path, bad):
    client, bucket, _, provenance, _ = candidate
    # No objects exist, so a storage read would raise KeyError.
    with pytest.raises(ValueError, match='manifest SHA-256'):
        m.restore(client, bucket, 'browser-iso/candidates/123/1/yellowfin-gnome/s1/manifest.json',
                  tmp_path / 'bad.iso', provenance['iso']['sha256'], bad)
