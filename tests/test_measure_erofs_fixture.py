import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('measure', (Path(__file__).parent / 'measure_erofs_fixture.py') if (Path(__file__).parent / 'measure_erofs_fixture.py').exists() else (Path(__file__).resolve().parents[1] / 'scripts' / 'measure_erofs_fixture.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'source'
        self.expected = m.fixture(self.root, 64)

    def test_roundtrip_inventory_stable(self):
        self.assertEqual(m.inventory(self.root), self.expected)

    def test_content_tamper(self):
        (self.root / 'text').write_bytes(b'x' * (self.root / 'text').stat().st_size)
        self.assertNotEqual(m.inventory(self.root), self.expected)

    def test_missing_xattr(self):
        os.removexattr(self.root / 'text', 'user.fixture')
        self.assertNotEqual(m.inventory(self.root), self.expected)

    def test_changed_hardlink(self):
        (self.root / 'empty-link').unlink()
        (self.root / 'empty-link').touch()
        self.assertNotEqual(m.inventory(self.root), self.expected)

    def test_external_symlink_rejected(self):
        os.symlink('/etc/passwd', self.root / 'external')
        with self.assertRaisesRegex(ValueError, 'unsafe symlink'):
            m.inventory(self.root)

    def test_parent_symlink_rejected(self):
        os.symlink('../outside', self.root / 'external')
        with self.assertRaisesRegex(ValueError, 'unsafe symlink'):
            m.inventory(self.root)

    def test_metadata_tamper(self):
        (self.root / 'run').chmod(0o644)
        self.assertNotEqual(m.inventory(self.root), self.expected)

    def test_entry_budget(self):
        with patch.object(m, 'MAX_ENTRIES', 2), self.assertRaisesRegex(ValueError, 'entry budget'):
            m.inventory(self.root)

    def test_byte_boundary(self):
        total = sum(v.get('size', 0) for v in self.expected.values())
        with patch.object(m, 'MAX_BYTES', total):
            self.assertEqual(m.inventory(self.root), self.expected)
        with patch.object(m, 'MAX_BYTES', total - 1), self.assertRaisesRegex(ValueError, 'byte budget'):
            m.inventory(self.root)

    def test_copy_equal(self):
        source = self.root / 'text'
        dest = self.base / 'copy'
        m.verified_copy(source, dest, m.digest(source))
        self.assertEqual(source.read_bytes(), dest.read_bytes())

    def test_copy_bad_hash(self):
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            m.verified_copy(self.root / 'text', self.base / 'copy', '0' * 64)

    def test_copy_symlink_rejected(self):
        with self.assertRaises(OSError):
            m.verified_copy(self.root / 'link', self.base / 'copy', m.digest(self.root / 'text'))

    def test_copy_no_overwrite(self):
        dest = self.base / 'copy'
        dest.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            m.verified_copy(self.root / 'text', dest, m.digest(self.root / 'text'))
        self.assertEqual(dest.read_bytes(), b'keep')

    def test_truncated_source_rejected(self):
        source = self.root / 'text'
        expected = m.digest(source)
        source.write_bytes(source.read_bytes()[:-1])
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            m.verified_copy(source, self.base / 'copy', expected)

    def test_replaced_source_path_rejected(self):
        source = self.root / 'text'
        old_lstat = Path.lstat
        replacement = self.base / 'replacement'
        replacement.write_bytes(source.read_bytes())
        def swapped(path):
            if path == source:
                os.replace(replacement, source)
            return old_lstat(path)
        with patch.object(Path, 'lstat', swapped), self.assertRaisesRegex(ValueError, 'source changed'):
            m.verified_copy(source, self.base / 'copy', m.digest(source))

    def test_process_timeout_remains_failure(self):
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('fixture', 30)):
            with self.assertRaises(subprocess.TimeoutExpired):
                m.run(['fixture'])

    def test_process_output_limit_is_installed(self):
        with patch.object(m.resource, 'setrlimit') as limit:
            def fake_run(command, **kwargs):
                self.assertEqual(kwargs['timeout'], 30)
                self.assertTrue(kwargs['check'])
                kwargs['preexec_fn']()
            with patch.object(m.subprocess, 'run', side_effect=fake_run):
                m.run(['fixture'])
            limit.assert_called_once_with(m.resource.RLIMIT_FSIZE, (m.MAX_IMAGE, m.MAX_IMAGE))

    def test_workspace_budget(self):
        with patch.object(m, 'MAX_WORKSPACE', 1), self.assertRaisesRegex(ValueError, 'workspace byte budget'):
            m.workspace_bytes(self.base)

    def test_copy_size_budget(self):
        with patch.object(m, 'MAX_IMAGE', 1), self.assertRaisesRegex(ValueError, 'budget'):
            m.verified_copy(self.root / 'text', self.base / 'copy', m.digest(self.root / 'text'))


if __name__ == '__main__':
    unittest.main()
