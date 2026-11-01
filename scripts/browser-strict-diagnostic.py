#!/usr/bin/env python3
"""Run the retained browser LUKS leg through the pinned diagnostic containment.

No native-producer conversion, root harness, raw service output, or qualification.
The immutable tunaOS module owns process identity, signaling and cgroup cleanup.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import socketserver
import subprocess
import sys
import threading
import time

HARNESS_SHA = 'a700a7d3aa393361793a8e5966284f310fe36dab'
IDENTITIES = ('source', 'overlay', 'installer', 'engine', 'media')
PROFILE = ('PLATFORM', 'CPU_BASELINE', 'HARDWARE_SCOPE', 'BROWSER_NAME',
           'BROWSER_VERSION', 'BROWSER_MEMORY_GIB', 'BROWSER_FREE_DISK_GIB')


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def load_supervisor(root):
    root = Path(root).absolute()
    require(not any(p.is_symlink() for p in (root, *root.parents)), 'harness_symlink')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    require(head == HARNESS_SHA, 'harness_revision')
    require(not subprocess.check_output(['git', 'status', '--porcelain'], cwd=root), 'harness_dirty')
    sys.path.insert(0, str(root / 'scripts'))
    spec = importlib.util.spec_from_file_location('browser_pinned_diagnostic', root / 'scripts/diagnose-installed-luks.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def browser_environment(binding, iso, environment, module):
    require(environment.get('STRICT_INSTALL_MODE') == 'luks' and
            environment.get('DIAGNOSTIC_UNQUALIFIED') == 'true', 'diagnostic_luks_only')
    require(environment.get('TUNAOS_QUAL_EXECUTION_KIND') == 'browser' and
            environment.get('STRICT_PUBLISHED_MEDIA') == '0', 'browser_context')
    require(binding.get('schema') == 'BrowserIsoSameByteGuestTest/v1' and
            binding.get('qualification') == 'diagnostic-unqualified', 'binding_context')
    producer = binding.get('producer', {})
    for key, env_key in (('repository', 'GITHUB_REPOSITORY'), ('runId', 'GITHUB_RUN_ID'),
                         ('runAttempt', 'GITHUB_RUN_ATTEMPT'), ('sha', 'GITHUB_SHA')):
        require(producer.get(key) == environment.get(env_key), 'same_run_binding')
    require(producer.get('repository') == 'tuna-os/iso-builder' and
            isinstance(producer.get('artifactId'), int) and producer['artifactId'] > 0,
            'browser_artifact')
    require(binding.get('target', {}).get('image') == 'tuna-os/skipjack:gnome' and
            binding['target'].get('platform') == 'linux/amd64', 'browser_target')
    media = binding.get('iso', {})
    require(iso.stat().st_size == media.get('sizeBytes') and
            module.file_digest(iso, time.monotonic() + 300) == media.get('sha256'), 'media_binding')
    identities = binding.get('identities', {})
    env = {key: environment[key] for key in ('PATH', 'HOME', 'LANG') if key in environment}
    for key in IDENTITIES:
        value = media.get('sha256') if key == 'media' else identities.get(key)
        require(value and value == environment.get('TUNAOS_QUAL_' + key.upper() + '_DIGEST'), 'identity_binding')
        env['TUNAOS_QUAL_' + key.upper() + '_DIGEST'] = value
    source_ref = identities.get('sourceRef')
    require(source_ref == 'tuna-os/skipjack:gnome' and
            source_ref == environment.get('TUNAOS_QUAL_SOURCE_REF'), 'source_ref_binding')
    env['TUNAOS_QUAL_SOURCE_REF'] = source_ref
    for key in PROFILE:
        value = environment.get('TUNAOS_QUAL_' + key)
        require(isinstance(value, str) and value and '\n' not in value, 'browser_profile')
        env['TUNAOS_QUAL_' + key] = value
    env.update(VARIANT='skipjack', FLAVOR='gnome', TUNAOS_QUAL_EXECUTION_KIND='browser',
               STRICT_PUBLISHED_MEDIA='0', TBOX_E2E_GPU='plain', TUNAOS_INSTALLED_BOOT_DIAGNOSTIC='1')
    return env


def stop_services(services):
    stopped = True
    for service in services:
        try:
            stopped = service.stop() and stopped
        except Exception:
            stopped = False
    return stopped


class QemuEndpoint:
    """Adapt the pinned owner's existing proxy protocol; never contain processes here."""
    def __init__(self, module, executable, output):
        self.module = module
        self.owner = module.OwnedQemu(str(executable), output)
        self.path = output / 'qemu-supervisor.sock'
        require(len(os.fsencode(self.path)) < 108, 'supervisor_socket_path')
        owner = self.owner

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                try:
                    self.connection.settimeout(40)
                    raw = self.rfile.readline(32769)
                    require(len(raw) <= 32768, 'request_limit')
                    command = json.loads(raw)
                    if isinstance(command, dict):
                        require(set(command) == {'signal', 'pid'} and type(command['pid']) is int and
                                command['pid'] > 0 and type(command['signal']) is int and
                                command['signal'] in (0, 9, 15), 'signal_request')
                        self.wfile.write(f"{owner.signal_owned(command['signal'], command['pid'])}\n".encode())
                    else:
                        require(isinstance(command, list) and all(isinstance(a, str) for a in command), 'request_type')
                        owner.launch(command)
                        self.wfile.write(b'ok\n')
                except Exception:
                    self.wfile.write(b'refused\n')

        self.server = socketserver.UnixStreamServer(str(self.path), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        try:
            os.chmod(self.path, 0o600)
            self.thread.start()
        except Exception:
            self.server.server_close()
            self.path.unlink(missing_ok=True)
            raise

    def close(self):
        stopped = True
        for action in (self.server.shutdown, self.server.server_close,
                       lambda: self.thread.join(timeout=45)):
            try:
                action()
            except Exception:
                stopped = False
        stopped = not self.thread.is_alive() and stopped
        try:
            if self.owner.children:
                self.owner.stop()
        except Exception:
            stopped = False
        stopped = stop_services(self.module.OWNED_SERVICES) and stopped
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            stopped = False
        return stopped


def proxy_wrapper(module, output):
    wrapper = output / 'qemu-proxy'
    wrapper.write_text('#!/usr/bin/env python3\nimport os,sys\nos.execv(' + repr(sys.executable) +
                       ', [' + repr(sys.executable) + ',' + repr(module.__file__) + ',"proxy",*sys.argv[1:]])\n')
    wrapper.chmod(0o700)
    return wrapper


def run_guest(module, root, iso, output, env):
    require(os.getuid() > 0 and os.getuid() == os.geteuid(), 'unprivileged_supervisor_required')
    qemu = Path('/usr/bin/qemu-system-x86_64')
    require(qemu.is_file() and not qemu.is_symlink(), 'qemu_missing')
    endpoint = QemuEndpoint(module, qemu, output)
    harness = None
    rc, stopped = 77, False
    try:
        env.update(QEMU=str(proxy_wrapper(module, output)), TUNAOS_DIAGNOSTIC_SOCKET=str(endpoint.path))
        harness = module.ContainedProcess(['bash', str(root / 'scripts/iso-e2e.sh'), str(iso),
                                           '--strict-offline-gui=luks', '--output', str(output), '--timeout', '900'],
                                          env=env, supplementary_groups=('kvm',))
        deadline = time.monotonic() + 3600
        while harness.poll() is None:
            endpoint.owner.reap()
            if time.monotonic() >= deadline:
                rc = 124
                break
            time.sleep(1)
        else:
            rc = harness.returncode
    finally:
        # Preserve the primary failure; cleanup can only turn success into failure.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            stopped = endpoint.close()
        except Exception:
            stopped = False
        stopped = stop_services(module.OWNED_SERVICES) and stopped
        report = {'schema': 'BrowserStrictDiagnosticSupervisor/v1', 'qualification': 'diagnostic-unqualified',
                  'executionKind': 'browser', 'installMode': 'luks', 'strictExit': rc,
                  'cleanupProven': stopped, 'supervisedVmCount': len(endpoint.owner.children),
                  'mediaDigest': env.get('TUNAOS_QUAL_MEDIA_DIGEST'),
                  'engineDigest': env.get('TUNAOS_QUAL_ENGINE_DIGEST'),
                  'services': [service.proof() for service in module.OWNED_SERVICES]}
        report_written = True
        try:
            (output / 'browser-diagnostic-supervisor.json').write_text(json.dumps(report, sort_keys=True) + '\n')
        except OSError:
            report_written = False
    return rc if rc else (0 if stopped and endpoint.owner.children and report_written else 77)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--harness-root', type=Path, required=True)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--binding', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    module = load_supervisor(args.harness_root)
    require(args.binding.is_file() and not args.binding.is_symlink() and args.binding.stat().st_size <= 1024**2,
            'binding_file')
    binding = json.loads(args.binding.read_bytes())
    env = browser_environment(binding, args.iso.absolute(), os.environ, module)
    output = args.output.absolute()
    require(not any(p.is_symlink() for p in (output, *output.parents)), 'output_symlink')
    output.mkdir(mode=0o700)
    return run_guest(module, args.harness_root.absolute(), args.iso.absolute(), output, env)


if __name__ == '__main__':
    def interrupted(_number, _frame):
        raise InterruptedError('diagnostic_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt):
        # Do not print arbitrary exception text, commands, or guest output.
        print('browser diagnostic supervisor refused; no qualification', file=sys.stderr)
        raise SystemExit(77)
