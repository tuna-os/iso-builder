"""Browser-bound invocation uses the immutable owner, never a native producer CLI."""
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('browser_diagnostic', ROOT / 'scripts/browser-strict-diagnostic.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def inputs(tmp_path):
    iso = tmp_path / 'fixture.iso'
    iso.write_bytes(b'non-bootable test bytes')
    digest = 'sha256:' + hashlib.sha256(iso.read_bytes()).hexdigest()
    binding = {
        'schema': 'BrowserIsoSameByteGuestTest/v1', 'qualification': 'diagnostic-unqualified',
        'producer': {'repository': 'tuna-os/iso-builder', 'runId': '17', 'runAttempt': '1',
                     'sha': 'a' * 40, 'artifactId': 99},
        'target': {'image': 'tuna-os/skipjack:gnome', 'platform': 'linux/amd64'},
        'iso': {'sha256': digest, 'sizeBytes': iso.stat().st_size},
        'identities': {key: 'sha256:' + str(n) * 64 for n, key in enumerate(adapter.IDENTITIES[:-1], 1)},
    }
    env = {'PATH': '/usr/bin', 'HOME': str(tmp_path), 'LANG': 'C.UTF-8',
           'STRICT_INSTALL_MODE': 'luks', 'DIAGNOSTIC_UNQUALIFIED': 'true',
           'TUNAOS_QUAL_EXECUTION_KIND': 'browser', 'STRICT_PUBLISHED_MEDIA': '0',
           'GITHUB_REPOSITORY': 'tuna-os/iso-builder', 'GITHUB_RUN_ID': '17',
           'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a' * 40,
           'TUNAOS_QUAL_MEDIA_DIGEST': digest,
           **{'TUNAOS_QUAL_' + key.upper() + '_DIGEST': value for key, value in binding['identities'].items()},
           **{'TUNAOS_QUAL_' + key: 'fixture-profile' for key in adapter.PROFILE}}
    module = SimpleNamespace(file_digest=lambda path, deadline: 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest())
    binding['identities']['sourceRef'] = 'tuna-os/skipjack:gnome'
    env['TUNAOS_QUAL_SOURCE_REF'] = binding['identities']['sourceRef']
    return iso, binding, env, module


def test_browser_binding_preserves_identity_without_forwarding_credentials(tmp_path):
    iso, binding, env, module = inputs(tmp_path)
    env.update(GITHUB_TOKEN='must-not-forward', QEMU='untrusted', TUNAOS_DIAGNOSTIC_SOCKET='dummy')
    actual = adapter.browser_environment(binding, iso, env, module)
    assert actual['TUNAOS_QUAL_EXECUTION_KIND'] == 'browser'
    assert actual['STRICT_PUBLISHED_MEDIA'] == '0'
    assert actual['TUNAOS_INSTALLED_BOOT_DIAGNOSTIC'] == '1'
    assert actual['TUNAOS_QUAL_ENGINE_DIGEST'] == binding['identities']['engine']
    assert actual['TUNAOS_QUAL_MEDIA_DIGEST'] == binding['iso']['sha256']
    assert not {'GITHUB_TOKEN', 'QEMU', 'TUNAOS_DIAGNOSTIC_SOCKET'} & actual.keys()


@pytest.mark.parametrize('key,value', [
    ('STRICT_INSTALL_MODE', 'plain'), ('DIAGNOSTIC_UNQUALIFIED', 'false'),
    ('TUNAOS_QUAL_EXECUTION_KIND', 'native-qemu'), ('STRICT_PUBLISHED_MEDIA', '1'),
    ('GITHUB_RUN_ID', '18'), ('GITHUB_SHA', 'b' * 40), ('TUNAOS_QUAL_ENGINE_DIGEST', 'different'),
    ('TUNAOS_QUAL_BROWSER_VERSION', ''),
])
def test_wrong_context_or_binding_refused_before_child_launch(tmp_path, key, value):
    iso, binding, env, module = inputs(tmp_path)
    env[key] = value
    with pytest.raises(ValueError):
        adapter.browser_environment(binding, iso, env, module)


@pytest.mark.parametrize('change', ['qualified', 'native-producer', 'wrong-artifact', 'changed-media', 'wrong-target'])
def test_cannot_relabel_or_substitute_the_retained_media(tmp_path, change):
    iso, binding, env, module = inputs(tmp_path)
    if change == 'qualified':
        binding['qualification'] = 'qualified'
    elif change == 'native-producer':
        binding['producer']['repository'] = 'tuna-os/tunaOS'
    elif change == 'wrong-artifact':
        binding['producer']['artifactId'] = 0
    elif change == 'changed-media':
        iso.write_bytes(b'changed')
    else:
        binding['target']['platform'] = 'linux/amd64/v2'
    with pytest.raises(ValueError):
        adapter.browser_environment(binding, iso, env, module)


def request(endpoint, value):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(endpoint.path))
        client.sendall(json.dumps(value).encode() + b'\n')
        return client.recv(1024)


class Service:
    def __init__(self, result=True, raises=False):
        self.result, self.raises, self.called = result, raises, 0

    def stop(self):
        self.called += 1
        if self.raises:
            raise RuntimeError('fixture stop failure')
        return self.result

    def proof(self):
        return {'stopped': self.called > 0 and self.result and not self.raises}


class Owner:
    def __init__(self, executable, output):
        self.executable, self.output = executable, output
        self.children, self.launches, self.signals = [], [], []

    def launch(self, args):
        if args != ['-daemonize', '-pidfile', str(self.output / 'qemu.pid')]:
            raise ValueError('launch_shape')
        self.launches.append(args)
        self.children.append(Service())

    def signal_owned(self, number, pid):
        self.signals.append((number, pid))
        return 0 if self.children and pid == 17 else 64

    def stop(self):
        return all(child.stop() for child in self.children)


def test_real_unix_socket_delegates_launch_and_only_owned_signals(tmp_path):
    module = SimpleNamespace(OwnedQemu=Owner, OWNED_SERVICES=[])
    endpoint = adapter.QemuEndpoint(module, '/fixture/qemu', tmp_path)
    try:
        assert endpoint.path.stat().st_mode & 0o777 == 0o600
        assert request(endpoint, ['not-qemu-arguments']) == b'refused\n'
        assert request(endpoint, {'signal': 15, 'pid': 17}) == b'64\n'
        assert request(endpoint, ['-daemonize', '-pidfile', str(tmp_path / 'qemu.pid')]) == b'ok\n'
        assert request(endpoint, {'signal': 0, 'pid': 17}) == b'0\n'
        assert request(endpoint, {'signal': True, 'pid': 17}) == b'refused\n'
        assert request(endpoint, {'signal': 15, 'pid': 999}) == b'64\n'
    finally:
        assert endpoint.close()
    assert not endpoint.path.exists()
    assert not endpoint.thread.is_alive()
    assert endpoint.owner.children[0].called == 1


def test_cleanup_attempts_every_service_even_after_refusal(tmp_path):
    services = [Service(raises=True), Service(result=False), Service()]
    module = SimpleNamespace(OwnedQemu=Owner, OWNED_SERVICES=services)
    endpoint = adapter.QemuEndpoint(module, '/fixture/qemu', tmp_path)
    assert not endpoint.close()
    assert [service.called for service in services] == [1, 1, 1]
    assert not endpoint.path.exists()
    assert not endpoint.thread.is_alive()


@pytest.mark.parametrize('primary,cleanup,report_failure,expected', [
    (0, True, False, 0), (0, False, False, 77), (19, False, False, 19),
    (0, True, True, 77), (19, True, True, 19), (124, True, True, 124),
])
def test_contained_harness_preserves_window_primary_failure_and_cleanup(tmp_path, monkeypatch, primary, cleanup, report_failure, expected):
    calls = []
    services = []
    class Harness(Service):
        returncode = primary
        def poll(self):
            return self.returncode
    harness = Harness(result=cleanup)
    def contained(command, **kwargs):
        calls.append((command, kwargs))
        services.append(harness)
        return harness
    class Endpoint:
        def __init__(self, module, executable, output):
            self.path = output / 'real-endpoint-location'
            self.owner = SimpleNamespace(children=[Service()])
        def close(self):
            calls.append('close-endpoint')
            return cleanup
    monkeypatch.setattr(adapter, 'QemuEndpoint', Endpoint)
    monkeypatch.setattr(adapter.Path, 'is_file', lambda path: True)
    monkeypatch.setattr(adapter.Path, 'is_symlink', lambda path: False)
    monkeypatch.setattr(adapter.os, 'getuid', lambda: 1000)
    monkeypatch.setattr(adapter.os, 'geteuid', lambda: 1000)
    monkeypatch.setattr(adapter.signal, 'signal', lambda *args: None)
    if report_failure:
        write_text = adapter.Path.write_text
        def fail_report(path, *args, **kwargs):
            if path.name == 'browser-diagnostic-supervisor.json':
                raise OSError('fixture disk full')
            return write_text(path, *args, **kwargs)
        monkeypatch.setattr(adapter.Path, 'write_text', fail_report)
    module = SimpleNamespace(ContainedProcess=contained, OWNED_SERVICES=services, __file__='/immutable/supervisor.py')
    env = {'TUNAOS_QUAL_EXECUTION_KIND': 'browser', 'STRICT_PUBLISHED_MEDIA': '0'}
    assert adapter.run_guest(module, Path('/immutable'), tmp_path / 'fixture.iso', tmp_path, env) == expected
    command, kwargs = calls[0]
    assert command[-2:] == ['--timeout', '900']
    assert '--strict-offline-gui=luks' in command
    assert kwargs['supplementary_groups'] == ('kvm',)
    assert kwargs['env']['TUNAOS_QUAL_EXECUTION_KIND'] == 'browser'
    assert kwargs['env']['STRICT_PUBLISHED_MEDIA'] == '0'
    assert kwargs['env']['TUNAOS_DIAGNOSTIC_SOCKET'] == str(tmp_path / 'real-endpoint-location')
    assert calls[1] == 'close-endpoint' and harness.called == 1
    report_path = tmp_path / 'browser-diagnostic-supervisor.json'
    if report_failure:
        assert not report_path.exists()
    else:
        report = json.loads(report_path.read_text())
        assert report['strictExit'] == primary and report['cleanupProven'] == cleanup
        assert report['qualification'] == 'diagnostic-unqualified'


def test_harness_revision_refused_before_import(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter.subprocess, 'check_output', lambda *args, **kwargs: 'b' * 40)
    with pytest.raises(ValueError, match='harness_revision'):
        adapter.load_supervisor(tmp_path)
