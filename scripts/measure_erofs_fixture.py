"""Tiny native EROFS experiment; no browser, ISO, or boot qualification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import resource
import shutil
import stat
import subprocess
import tempfile
import time

MAX_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 64
MAX_IMAGE = 16 * 1024 * 1024
MAX_WORKSPACE = 96 * 1024 * 1024
EPOCH = 1700000000


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def inventory(root):
    result, groups, total = {}, {}, 0
    paths = [root, *sorted(root.rglob('*'))]
    if len(paths) > MAX_ENTRIES:
        raise ValueError('entry budget')
    for path in paths:
        rel = path.relative_to(root).as_posix()
        if len(path.relative_to(root).parts) > 4:
            raise ValueError('depth budget')
        s = path.lstat()
        mode = stat.S_IFMT(s.st_mode)
        item = {'type': mode, 'mode': stat.S_IMODE(s.st_mode), 'uid': s.st_uid,
                'gid': s.st_gid, 'mtime_ns': s.st_mtime_ns}
        if stat.S_ISREG(s.st_mode):
            total += s.st_size
            if total > MAX_BYTES:
                raise ValueError('byte budget')
            item.update(size=s.st_size, sha256=digest(path))
            groups.setdefault((s.st_dev, s.st_ino), []).append(rel)
        elif stat.S_ISLNK(s.st_mode):
            target = os.readlink(path)
            if os.path.isabs(target) or '..' in Path(target).parts:
                raise ValueError('unsafe symlink')
            item['target'] = target
        elif not stat.S_ISDIR(s.st_mode):
            raise ValueError('unsupported file type')
        item['xattrs'] = {k: os.getxattr(path, k, follow_symlinks=False).hex()
                         for k in sorted(os.listxattr(path, follow_symlinks=False))}
        result[rel] = item
    for names in groups.values():
        for name in names:
            result[name]['hardlinks'] = sorted(names)
    return result


def fixture(root, size=3 * 1024 * 1024):
    root.mkdir()
    (root / 'nested').mkdir()
    (root / 'text').write_bytes((b'bounded erofs fixture\n' * (size // 22 + 1))[:size])
    rng = random.Random(20261021)
    (root / 'nested' / 'noise').write_bytes(rng.randbytes(size))
    (root / 'empty').touch()
    (root / 'run').write_bytes(b'#!/bin/sh\nexit 0\n')
    (root / 'run').chmod(0o755)
    (root / 'caf\u00e9').write_bytes(b'utf8 path\n')
    os.link(root / 'empty', root / 'empty-link')
    os.symlink('text', root / 'link')
    os.setxattr(root / 'text', 'user.fixture', b'bounded-v1')
    for p in [*root.rglob('*'), root]:
        os.utime(p, (EPOCH, EPOCH), follow_symlinks=False)
    return inventory(root)


def workspace_bytes(root):
    total = 0
    for path in root.rglob('*'):
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
            if total > MAX_WORKSPACE:
                raise ValueError('workspace byte budget')
    return total


def run(command):
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_IMAGE, MAX_IMAGE))
    start = time.monotonic_ns()
    subprocess.run(command, check=True, timeout=30, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, preexec_fn=limits)
    return {'elapsed_ns': time.monotonic_ns() - start,
            'children_peak_rss_kib': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}


def verified_copy(source, destination, expected):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_IMAGE:
            raise ValueError('source image budget/type')
        h = hashlib.sha256()
        with os.fdopen(os.dup(fd), 'rb') as src, destination.open('xb') as dst:
            count = 0
            for block in iter(lambda: src.read(1024 * 1024), b''):
                count += len(block)
                if count > MAX_IMAGE:
                    raise ValueError('copy budget')
                h.update(block)
                dst.write(block)
        after = os.fstat(fd)
        current = source.lstat()
        fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if fields(before) != fields(after) or fields(before) != fields(current):
            raise ValueError('source changed')
        if h.hexdigest() != expected or digest(destination) != expected:
            raise ValueError('copy digest mismatch')
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'erofs-utils'], text=True)
    if version != '1.8.6-1':
        raise ValueError('unexpected erofs-utils version')
    results = []
    with tempfile.TemporaryDirectory(prefix='erofs-tiny-') as temp:
        root = Path(temp)
        source = root / 'source'
        expected = fixture(source)
        for iteration in range(3):
            for variant, flags in [('plain', []), ('lz4', ['-z', 'lz4'])]:
                image = root / 'root.erofs'
                record = {'iteration': iteration, 'variant': variant}
                samples = [workspace_bytes(root)]
                record['author'] = run(['mkfs.erofs', '-b', '4096', '-T', str(EPOCH), '-U',
                    '00000000-0000-0000-0000-000000000000', *flags, str(image), str(source)])
                if image.stat().st_size > MAX_IMAGE:
                    raise ValueError('image budget')
                samples.append(workspace_bytes(root))
                record['image_bytes'] = image.stat().st_size
                start = time.monotonic_ns()
                record['sha256'] = digest(image)
                record['hash_elapsed_ns'] = time.monotonic_ns() - start
                for kind in ['authored', 'copied']:
                    selected = image
                    if kind == 'copied':
                        selected = root / 'copy.erofs'
                        start = time.monotonic_ns()
                        verified_copy(image, selected, record['sha256'])
                        record['copy_elapsed_ns'] = time.monotonic_ns() - start
                    extracted = root / 'extracted'
                    record[kind + '_extract'] = run(['fsck.erofs', '--extract=' + str(extracted),
                        '--xattrs', '--preserve', str(selected)])
                    samples.append(workspace_bytes(root))
                    if inventory(extracted) != expected:
                        raise ValueError('content or metadata roundtrip mismatch')
                    shutil.rmtree(extracted)
                    if kind == 'copied':
                        selected.unlink()
                record['roundtrip_equal'] = True
                record['checkpoint_storage_high_water_bytes'] = max(samples)
                results.append(record)
                image.unlink()
    result = {'kind': 'tiny-native-erofs-feasibility', 'qualification': 'not-assessed',
              'wasm_compression_proven': False, 'boot_compatibility_proven': False,
              'xattr_scope': 'user.fixture only; no SELinux labels or capabilities',
              'corpus_scope': 'tiny synthetic fixture, not a full OS metadata corpus',
              'plain_author': 'native erofs-utils, not the current Go writer',
              'erofs_utils_version': version, 'results': results,
              'rss_scope': 'cumulative child high-water, not per-phase isolated peak',
              'storage_scope': 'phase-boundary samples; transient peak may be higher'}
    data = json.dumps(result, sort_keys=True) + '\n'
    if len(data.encode()) > 65536:
        raise ValueError('result budget')
    Path(args.output).write_text(data)
    print(data, end='')


if __name__ == '__main__':
    main()
