"""Pure source-origin consistency binding; no network, receipt, or qualification.

Inputs must come from separate channels: source observations from the engine's
actual OCI resolve call, coordinates of that invocation from the operation, and
an independently reviewed origin-to-proxy policy plus expected immutable ref.
Never construct the policy or expected ref from candidate/catalog observations.

The engine reports the transport endpoint, repository, requested tag/digest, and
verified child/index digest. This helper compares those reports; it does not
measure bytes or authenticate the engine or proxy. Registry origin is an explicit
trusted mapping, not a fact inferred from a proxy hostname. Platform/CPU policy,
config descriptors, and any other caller fields are not source-origin evidence.
"""
import ipaddress
import re
from urllib.parse import urlsplit


class SourceOriginError(ValueError):
    """Missing, malformed, ambiguous, or inconsistent source-origin inputs."""


def _fail(field, reason):
    raise SourceOriginError(f'{field}: {reason}')


def _text(value, field, maximum=2048):
    if (type(value) is not str or not 0 < len(value) <= maximum or
            any(ord(char) < 33 or ord(char) > 126 for char in value)):
        _fail(field, 'expected nonempty bounded ASCII without whitespace')
    return value


def _authority(value, field):
    """Canonical lower-case DNS/IPv4 registry authority with optional port."""
    _text(value, field, 253 + 6)
    match = re.fullmatch(r'([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?', value)
    if match is None:
        _fail(field, 'expected canonical registry host and optional port')
    host, port = match.groups()
    if (len(host) > 253 or any(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) is None
                             for part in host.split('.')) or port and int(port) > 65535):
        _fail(field, 'invalid host or port')
    if re.fullmatch(r'[0-9.]+', host):
        try:
            ipaddress.IPv4Address(host)
        except ValueError as exc:
            raise SourceOriginError(f'{field}: invalid IPv4 address') from exc
    elif re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]*)', host.rsplit('.', 1)[-1]):
        # Browser URL parsing treats a numeric last label as an IPv4 attempt,
        # including hexadecimal spellings. Do not admit DNS-looking aliases
        # such as 0x7f000001 or 0x7f.0.0.1 as independent transport identities.
        _fail(field, 'noncanonical numeric host')
    return value


def _endpoint(value, field):
    _text(value, field)
    if any(char in value for char in ('%', '\\', '?', '#', '@')):
        _fail(field, 'credentials, escapes, query, fragments, and backslashes are forbidden')
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise SourceOriginError(f'{field}: malformed endpoint') from exc
    if parsed.scheme != 'https' or not value.startswith('https://') or not parsed.netloc:
        _fail(field, 'explicit HTTPS endpoint required')
    _authority(parsed.netloc, field + '.authority')
    # These spellings denote an already representable transport. The engine
    # trims trailing slashes before resolving; HTTPS supplies port 443. Reject
    # aliases rather than normalizing the independently supplied coordinates.
    if parsed.port == 443 or value.endswith('/'):
        _fail(field, 'default HTTPS port and trailing slash aliases are forbidden')
    path = parsed.path
    if path:
        if re.fullmatch(r'(?:/[A-Za-z0-9._~-]+)+', path) is None:
            _fail(field, 'invalid proxy path')
        components = path[1:].split('/')
        if any(part in ('.', '..') for part in components):
            _fail(field, 'empty or traversing proxy path')
    return value


def _repository(value, field):
    _text(value, field, 255)
    component = r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
    if re.fullmatch(component + '(?:/' + component + ')*', value) is None:
        _fail(field, 'expected a canonical OCI repository path')
    return value


def _digest(value, field):
    _text(value, field, 71)
    if re.fullmatch(r'sha256:[0-9a-f]{64}', value) is None:
        _fail(field, 'expected sha256 digest')
    return value


def _reference(value, field):
    _text(value, field, 128)
    if value.startswith('sha256:'):
        return _digest(value, field)
    if re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', value) is None:
        _fail(field, 'expected an explicit OCI tag or digest')
    return value


def _coordinates(value, field):
    if type(value) is not dict:
        _fail(field, 'expected actual resolve-call coordinates')
    return {
        'registryEndpoint': _endpoint(value.get('registryEndpoint'), field + '.registryEndpoint'),
        'repository': _repository(value.get('repository'), field + '.repository'),
        'requestedReference': _reference(value.get('requestedReference'), field + '.requestedReference'),
    }


def _immutable_ref(value):
    _text(value, 'expected_source_ref')
    origin, separator, rest = value.partition('/')
    if not separator or rest.count('@') != 1:
        _fail('expected_source_ref', 'expected canonical origin/repository@child-digest')
    repository, digest = rest.split('@')
    return (_authority(origin, 'expected_source_ref.origin'),
            _repository(repository, 'expected_source_ref.repository'),
            _digest(digest, 'expected_source_ref.digest'))


def bind_source_origin(observed_source, operation_coordinates, trusted_origin_to_proxy, expected_source_ref):
    """Return a diagnostic binding of engine reports to independent policy.

    Both coordinate objects require registryEndpoint/repository/requestedReference.
    Supply the operation's actual resolve-call coordinates, not raw UI defaults,
    a catalog entry, or an unevaluated BuildRequest whose pins may be substituted.
    Older engine observations lacking these optional fields cannot be bound.

    Policy maps canonical origin authorities (optional port) to exact HTTPS proxy
    endpoints (optional nondefault port/path, without a trailing slash). A direct
    registry still needs an explicit identity mapping. Multiple origins mapped
    to one endpoint are ambiguous and
    rejected. No normalization, implicit default tag, origin guess, or fallback is
    performed. Default HTTPS port and numeric-host aliases are rejected rather
    than treated as distinct transports. Digest requests identify the index if
    observed, otherwise the child.
    """
    observed = _coordinates(observed_source, 'observed_source')
    operation = _coordinates(operation_coordinates, 'operation_coordinates')
    if observed != operation:
        _fail('operation_coordinates', 'engine resolve coordinates differ from the actual operation')
    child = _digest(observed_source.get('manifestDigest'), 'observed_source.manifestDigest')
    index = None
    if 'indexDigest' in observed_source:
        index = _digest(observed_source['indexDigest'], 'observed_source.indexDigest')
        if index == child:
            _fail('observed_source.indexDigest', 'index and child must be distinct')
    requested = observed['requestedReference']
    if requested.startswith('sha256:') and requested != (index or child):
        _fail('observed_source.requestedReference', 'digest request differs from the consumed index/child')
    origin, repository, expected_digest = _immutable_ref(expected_source_ref)
    if type(trusted_origin_to_proxy) is not dict or not trusted_origin_to_proxy:
        _fail('trusted_origin_to_proxy', 'independently reviewed mapping required')
    reverse = {}
    for declared_origin, proxy in trusted_origin_to_proxy.items():
        _authority(declared_origin, 'trusted_origin_to_proxy.origin')
        _endpoint(proxy, 'trusted_origin_to_proxy.endpoint')
        if proxy in reverse:
            _fail('trusted_origin_to_proxy', 'one transport endpoint has ambiguous registry origins')
        reverse[proxy] = declared_origin
    mapped_origin = reverse.get(observed['registryEndpoint'])
    if mapped_origin is None:
        _fail('trusted_origin_to_proxy', 'no reviewed mapping for the observed transport')
    if mapped_origin != origin or repository != observed['repository'] or expected_digest != child:
        _fail('expected_source_ref', 'origin, consumed repository, or child digest differs')
    canonical = mapped_origin + '/' + observed['repository'] + '@' + child
    if canonical != expected_source_ref:
        _fail('expected_source_ref', 'immutable reference is not canonical')
    return {
        'binding_valid': True,
        'authentication': 'not_authenticated',
        'engineObserved': {**observed, 'manifestDigest': child,
                           **({'indexDigest': index} if index is not None else {})},
        'declaredPolicy': {'origin': mapped_origin, 'transportEndpoint': trusted_origin_to_proxy[mapped_origin],
                           'expectedImmutableRef': expected_source_ref},
        'canonicalSourceRef': canonical,
    }
