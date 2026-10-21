"""Tiny pure fixtures; no registry, browser, storage, or engine is contacted."""
import copy
import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location('source_origin', Path(__file__).resolve().parents[1] / 'scripts/bind-source-origin.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CHILD = 'sha256:' + 'a' * 64
INDEX = 'sha256:' + 'b' * 64


@pytest.fixture
def inputs():
    observed = {'registryEndpoint': 'https://relay.tunaos.org', 'repository': 'tuna-os/yellowfin',
                'requestedReference': 'gnome', 'manifestDigest': CHILD, 'indexDigest': INDEX}
    operation = {key: observed[key] for key in ('registryEndpoint', 'repository', 'requestedReference')}
    return [observed, operation, {'ghcr.io': 'https://relay.tunaos.org'}, 'ghcr.io/tuna-os/yellowfin@' + CHILD]


def test_tagged_source_binds_engine_reports_without_claiming_origin_is_measured(inputs):
    before = copy.deepcopy(inputs)
    result = MODULE.bind_source_origin(*inputs)
    assert result == {
        'binding_valid': True, 'authentication': 'not_authenticated',
        'engineObserved': inputs[0],
        'declaredPolicy': {'origin': 'ghcr.io', 'transportEndpoint': 'https://relay.tunaos.org',
                           'expectedImmutableRef': inputs[3]},
        'canonicalSourceRef': inputs[3],
    }
    assert inputs == before
    assert 'origin' not in result['engineObserved']
    assert not {'qualified', 'cpuBaseline', 'platform', 'schemaVersion', 'kind'} & result.keys()


@pytest.mark.parametrize('indexed', [False, True])
def test_direct_and_index_digest_requests_preserve_child_identity(inputs, indexed):
    if not indexed:
        del inputs[0]['indexDigest']
    inputs[0]['requestedReference'] = inputs[1]['requestedReference'] = INDEX if indexed else CHILD
    result = MODULE.bind_source_origin(*inputs)
    assert result['canonicalSourceRef'].endswith('@' + CHILD)
    assert ('indexDigest' in result['engineObserved']) is indexed


@pytest.mark.parametrize('origin,endpoint', [
    ('registry.example:5443', 'https://proxy.example:9443/registries/source'),
    ('registry.example', 'https://registry.example'),
    ('127.0.0.1:5443', 'https://127.0.0.1:9443/proxy/v2'),
])
def test_explicit_mappings_support_ports_proxy_paths_and_direct_registry(inputs, origin, endpoint):
    inputs[0]['registryEndpoint'] = inputs[1]['registryEndpoint'] = endpoint
    inputs[2] = {origin: endpoint}
    inputs[3] = origin + '/tuna-os/yellowfin@' + CHILD
    assert MODULE.bind_source_origin(*inputs)['declaredPolicy']['origin'] == origin


@pytest.mark.parametrize('field,value', [
    ('registryEndpoint', 'https://other.example'), ('repository', 'attacker/yellowfin'),
    ('requestedReference', 'another-tag'),
])
def test_observations_must_match_actual_operation(inputs, field, value):
    inputs[0][field] = value
    with pytest.raises(MODULE.SourceOriginError, match='operation'):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('field', ['registryEndpoint', 'repository', 'requestedReference', 'manifestDigest'])
def test_legacy_or_missing_engine_observations_do_not_get_inferred(inputs, field):
    del inputs[0][field]
    inputs[0]['catalog'] = {'ref': inputs[3]}
    inputs[0]['cpuBaseline'] = 'x86-64-v2'
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('field', ['registryEndpoint', 'repository', 'requestedReference'])
def test_missing_actual_operation_coordinates_fail(inputs, field):
    del inputs[1][field]
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('policy', [None, {}, [], {'ghcr.io': 'https://unknown.example'},
                                    {'ghcr.io': 'https://relay.tunaos.org', 'other.example': 'https://relay.tunaos.org'}])
def test_unknown_missing_or_ambiguous_reviewed_mapping_fails(inputs, policy):
    inputs[2] = policy
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('endpoint,alias', [
    ('https://relay.tunaos.org', 'https://relay.tunaos.org:443'),
    ('https://relay.tunaos.org', 'https://relay.tunaos.org/'),
    ('https://relay.tunaos.org/proxy', 'https://relay.tunaos.org/proxy/'),
    ('https://127.0.0.1', 'https://0x7f000001'),
    ('https://127.0.0.1', 'https://0x7f.0.0.1'),
    ('https://127.0.0.1', 'https://127.0.0.0x1'),
])
def test_transport_alias_cannot_hide_an_ambiguous_origin_policy(inputs, endpoint, alias):
    inputs[0]['registryEndpoint'] = inputs[1]['registryEndpoint'] = endpoint
    inputs[2] = {'ghcr.io': endpoint, 'other.example': alias}
    with pytest.raises(MODULE.SourceOriginError, match='trusted_origin_to_proxy'):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('expected', [
    'other.example/tuna-os/yellowfin@' + CHILD,
    'ghcr.io/other/yellowfin@' + CHILD,
    'ghcr.io/tuna-os/yellowfin@' + INDEX,
])
def test_independent_origin_repository_and_child_digest_are_required(inputs, expected):
    inputs[3] = expected
    with pytest.raises(MODULE.SourceOriginError, match='expected_source_ref'):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('endpoint', [
    'http://relay.tunaos.org', 'https://user:pass@relay.tunaos.org', 'https://relay.tunaos.org?q=x',
    'https://relay.tunaos.org?', 'https://relay.tunaos.org#fragment', 'https://relay.tunaos.org#',
    'https://relay.tunaos.org/../registry', 'https://relay.tunaos.org/./registry',
    'https://relay.tunaos.org/%2e%2e/registry', 'https://relay.tunaos.org//registry',
    'https://relay.tunaos.org/registry//', 'https://relay.tunaos.org\\evil',
    'https://relay.tunaos.org:65536', 'https://relay.tunaos.org:0443',
    'https://relay.tunaos.org:443', 'https://relay.tunaos.org/',
    'https://relay.tunaos.org/registry/', 'https://0x7f000001',
    'https://0x7f.0.0.1', 'https://127.0.0.0x1', 'https://registry.123',
    'https://RELAY.tunaos.org', 'https://-relay.tunaos.org', 'https://bad_host.example',
    'https://999.1.1.1', 'https:///registry', '//relay.tunaos.org',
    'https://relay.tunaos.org\n', ' https://relay.tunaos.org', None, True,
])
def test_malformed_or_unsafe_endpoints_fail_even_with_matching_policy(inputs, endpoint):
    inputs[0]['registryEndpoint'] = inputs[1]['registryEndpoint'] = endpoint
    inputs[2]['ghcr.io'] = endpoint
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('repository', ['../tuna-os', 'tuna-os/../yellowfin', '/tuna-os/yellowfin',
                                       'tuna-os//yellowfin', 'tuna-os/yellowfin/', 'Tuna-os/yellowfin',
                                       'tuna-os/yellowfin:gnome', 'tuna-os/yellowfin@' + CHILD,
                                       'tuna-os/%2e%2e', 'tuna-os/yellowfin?q=1', '', None])
def test_malformed_repository_is_not_normalized(inputs, repository):
    inputs[0]['repository'] = inputs[1]['repository'] = repository
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('reference', ['', 'sha256:bad', 'sha256:' + 'A' * 64, '../tag', '.tag', '-tag',
                                      'tag@' + CHILD, 'latest?x=1', 'latest#x', 'tag:other', 'a' * 129, None])
def test_invalid_requested_references_fail(inputs, reference):
    inputs[0]['requestedReference'] = inputs[1]['requestedReference'] = reference
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('indexed', [False, True])
def test_digest_request_must_identify_consumed_index_or_direct_child(inputs, indexed):
    if not indexed:
        del inputs[0]['indexDigest']
    inputs[0]['requestedReference'] = inputs[1]['requestedReference'] = CHILD if indexed else INDEX
    with pytest.raises(MODULE.SourceOriginError, match='digest request'):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('origin', ['https://ghcr.io', 'user@ghcr.io', 'ghcr.io/path', 'GHCR.IO',
                                   'ghcr.io:0', 'ghcr.io:65536', 'ghcr.io.', 'ghcr.io?x=1', None])
def test_reviewed_policy_still_requires_well_formed_origins(inputs, origin):
    inputs[2] = {origin: inputs[0]['registryEndpoint']}
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('expected', [None, 'ghcr.io/tuna-os/yellowfin', 'ghcr.io/tuna-os/yellowfin:gnome',
                                     'https://ghcr.io/tuna-os/yellowfin@' + CHILD,
                                     'ghcr.io/tuna-os/yellowfin:gnome@' + CHILD,
                                     'ghcr.io/tuna-os/../yellowfin@' + CHILD,
                                     'ghcr.io/tuna-os/yellowfin@@' + CHILD,
                                     'ghcr.io/tuna-os/yellowfin@' + CHILD + '?x=1'])
def test_expected_ref_must_already_be_immutable_and_canonical(inputs, expected):
    inputs[3] = expected
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


@pytest.mark.parametrize('field,value', [('manifestDigest', None), ('manifestDigest', 'sha256:bad'),
                                        ('indexDigest', None), ('indexDigest', CHILD)])
def test_missing_or_impossible_digest_observations_fail(inputs, field, value):
    inputs[0][field] = value
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)


def test_other_observations_are_not_reclassified_as_measured_origin_or_policy(inputs):
    inputs[0]['config'] = {'bytesVerified': False}
    inputs[0]['origin'] = 'invented.example'
    inputs[0]['cpuBaseline'] = 'x86-64-v3'
    result = MODULE.bind_source_origin(*inputs)
    assert result['declaredPolicy']['origin'] == 'ghcr.io'
    assert not {'config', 'origin', 'cpuBaseline'} & result['engineObserved'].keys()


def test_proxy_hostname_never_becomes_implicit_origin(inputs):
    inputs[2] = {'ghcr.io': 'https://different.proxy.example'}
    inputs[3] = 'relay.tunaos.org/tuna-os/yellowfin@' + CHILD
    with pytest.raises(MODULE.SourceOriginError):
        MODULE.bind_source_origin(*inputs)
