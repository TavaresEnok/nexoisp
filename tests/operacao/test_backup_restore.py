"""Restore refuses incomplete artifacts/targets before invoking Docker."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('integrity', ROOT / 'scripts/backup-integrity.py')
integrity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integrity)


class BackupRestoreGuards(unittest.TestCase):
    def fixture(self, directory):
        dump = Path(directory) / 'synthetic.dump'
        dump.write_bytes(b'PGDMP synthetic')
        manifest = Path(str(dump) + '.manifest.json')
        manifest.write_text('{}\n')
        checksum = Path(str(dump) + '.sha256')
        checksum.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in (dump, manifest)))
        return dump, manifest, checksum

    def test_both_artifacts_required_and_no_path_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            dump, manifest, checksum = self.fixture(directory)
            integrity.verify(dump)
            original = checksum.read_text()
            for content in (original.splitlines()[0] + '\n', original + original, original.replace(dump.name, '../' + dump.name)):
                checksum.write_text(content)
                with self.assertRaises(ValueError):
                    integrity.verify(dump)
            checksum.write_text(original)
            manifest.write_text('{"tampered":true}')
            with self.assertRaises(ValueError):
                integrity.verify(dump)

    def test_compose_discovery_failure_aborts_wrapper(self):
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / 'docker'
            calls = Path(directory) / 'calls'
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "' + str(calls) + '"\nexit 42\n')
            docker.chmod(0o700)
            config = Path(directory) / 'synthetic.env'
            config.write_text('')
            env = {k: v for k, v in os.environ.items() if not k.startswith('NEXO_')}
            env.update(PATH=directory + ':' + env['PATH'], NEXO_PROD_ENV_FILE=str(config), NEXO_PROD_PROJECT='synthetic-only')
            result = subprocess.run(['bash', str(ROOT / 'scripts/prod-go.sh'), 'restore', 'not-used.dump', '--yes'], env=env, capture_output=True)
            self.assertEqual(result.returncode, 42)
            self.assertEqual(len(calls.read_text().splitlines()), 1)
            self.assertIn('ps --services --filter status=running', calls.read_text())

    def test_restore_requires_destination_and_lifecycle_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            dump, _, _ = self.fixture(directory)
            docker = Path(directory) / 'docker'
            marker = Path(directory) / 'unexpected-docker'
            docker.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 99\n')
            docker.chmod(0o700)
            env = {k: v for k, v in os.environ.items() if not k.startswith('NEXO_')}
            env.update(PATH=directory + ':' + env['PATH'], NEXO_DB_CONTAINER='synthetic-only')
            for target in ('', 'wrong/nexo', 'synthetic-only/nexo'):
                result = subprocess.run(['bash', str(ROOT / 'scripts/backup.sh'), 'restore', str(dump), '--yes'], env={**env, 'NEXO_RESTORE_TARGET': target}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ERRO:', result.stdout)
                self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
