"""Guardas do ensaio B12 que não precisam de Docker.

O harness real continua obrigatório. Estes testes só provam que identidade
herdada ou artefato manipulado aborta antes de um comando destrutivo.
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('restore_clean_host', ROOT / 'tests' / 'contrato' / 'restore_clean_host.py')
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


class RestoreCleanHostGuards(unittest.TestCase):
    def test_reserved_names_abort_before_mutation(self):
        for name in ('nexoisp-db-1', 'nexoisp-prod', 'nexo-fase1-db'):
            spec = harness.sample_spec()
            spec.source_container = name
            called = []
            with self.assertRaises(harness.RestoreRefused):
                harness.begin_mutations(spec, lambda: called.append('mutate'))
            self.assertEqual(called, [])

    def test_env_file_shared_volume_and_foreign_database(self):
        spec = harness.sample_spec()
        spec.env_file = '/srv/nexo/.env'
        with self.assertRaises(harness.RestoreRefused):
            harness.assert_lab_identity(spec)
        spec = harness.sample_spec()
        spec.dest_volume = spec.source_volume
        with self.assertRaises(harness.RestoreRefused):
            harness.assert_lab_identity(spec)
        spec = harness.sample_spec()
        spec.dest_database = 'nexo'
        with self.assertRaises(harness.RestoreRefused):
            harness.assert_lab_identity(spec)
        spec = harness.sample_spec()
        spec.source_owner_password = spec.dest_owner_password
        with self.assertRaises(harness.RestoreRefused):
            harness.assert_lab_identity(spec)

    def test_inherited_environment_is_dropped(self):
        spec = harness.sample_spec()
        ambient = {
            'PATH': '/usr/bin',
            'HOME': '/root',
            'DATABASE_URL_OWNER': 'postgres://nexoisp-prod/nexo',
            'NEXO_SECRET_KEY': 'herdada',
            'NEXO_PROD_ENV_FILE': '/srv/prod/.env',
            'PGPASSWORD': 'segredo-heredado',
        }
        env = harness.process_env(spec, 'destination', ambient)
        blob = json.dumps(env)
        self.assertNotIn('nexoisp-prod', blob)
        self.assertNotIn('herdada', blob)
        self.assertNotIn('.env', blob)
        self.assertNotIn('segredo-heredado', blob)
        self.assertNotIn('NEXO_PROD_ENV_FILE', env)
        self.assertEqual(env['NEXO_SECRET_KEY'], spec.aes_key)
        self.assertIn('/nexo_restore_check_4242_7', env['DATABASE_URL_OWNER'])
        self.assertIn(':25112/', env['DATABASE_URL_OWNER'])
        self.assertNotIn(':25111/', env['DATABASE_URL_GO'])
        self.assertEqual(env['NEXO_GO_JOBS'], '0')
        with self.assertRaises(harness.RestoreRefused):
            harness.process_env(spec, 'destination', ambient, database='nexo')

    def test_toolchain_keeps_only_build_keys(self):
        env = harness.toolchain_env({
            'PATH': '/bin',
            'GOCACHE': '/tmp/gocache',
            'GOTOOLCHAIN': 'local',
            'GOFLAGS': '-mod=readonly',
            'GOROOT': '/usr/local/go',
            'XDG_CACHE_HOME': '/tmp/xdg',
            'DATABASE_URL': 'postgres://nexoisp-prod/nexo',
            'NEXO_SECRET_KEY': 'herdada',
            'PGPASSWORD': 'segredo-heredado',
        })
        self.assertEqual(env['GOCACHE'], '/tmp/gocache')
        self.assertEqual(env['GOTOOLCHAIN'], 'local')
        self.assertEqual(env['GOFLAGS'], '-mod=readonly')
        self.assertEqual(env['GOROOT'], '/usr/local/go')
        self.assertEqual(env['XDG_CACHE_HOME'], '/tmp/xdg')
        self.assertEqual(env['CGO_ENABLED'], '0')
        self.assertTrue(env.get('HOME'))
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotIn('NEXO_SECRET_KEY', env)
        self.assertNotIn('PGPASSWORD', env)

    def test_toolchain_with_only_path_and_home(self):
        home = '/tmp/nexo-b12-toolchain-home'
        env = harness.toolchain_env({
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': home,
            'DATABASE_URL': 'postgres://nexoisp-prod/nexo',
            'NEXO_SECRET_KEY': 'herdada',
            'PGPASSWORD': 'segredo-heredado',
            'PGHOST': 'nexoisp-db-1',
        })
        self.assertEqual(env['HOME'], home)
        self.assertEqual(env['PATH'], os.environ.get('PATH', '/usr/bin:/bin'))
        self.assertEqual(env['CGO_ENABLED'], '0')
        self.assertEqual(env['GOPATH'], home + '/go')
        self.assertEqual(env['GOMODCACHE'], home + '/go/pkg/mod')
        self.assertEqual(env['GOCACHE'], home + '/.cache/go-build')
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotIn('NEXO_SECRET_KEY', env)
        self.assertNotIn('PGPASSWORD', env)
        self.assertNotIn('PGHOST', env)
        for key in env:
            self.assertFalse(key.startswith('DATABASE') or key.startswith('NEXO_') or key.startswith('PG'), key)
        probe = subprocess.run(
            ['go', 'env', 'GOMODCACHE'],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertEqual(probe.stdout.strip(), home + '/go/pkg/mod')
        self.assertNotIn('nexoisp-prod', probe.stdout)
        self.assertNotIn('herdada', probe.stdout)

    def test_existing_resource_aborts_before_delete(self):
        removed = []

        def create(name, inspect_code):
            harness.refuse_if_present(name, inspect_code)
            removed.append(name)

        with self.assertRaises(harness.RestoreRefused):
            create('nexo-b12-src-a1b2c3d4e5f6', 0)
        with self.assertRaises(harness.RestoreRefused):
            create('nexoisp-db-1', 1)
        self.assertEqual(removed, [])

    def test_cleanup_is_limited_to_this_run(self):
        spec = harness.sample_spec()
        plan = harness.cleanup_plan([
            {'kind': 'container', 'name': spec.source_container, 'run': spec.run_id, 'label': harness.LAB_LABEL},
            {'kind': 'volume', 'name': spec.dest_volume, 'run': spec.run_id, 'label': harness.LAB_LABEL},
        ], spec.run_id)
        self.assertEqual([item['name'] for item in plan], [spec.source_container, spec.dest_volume])
        with self.assertRaises(harness.RestoreRefused):
            harness.cleanup_plan([
                {'kind': 'container', 'name': 'nexoisp-db-1', 'run': spec.run_id, 'label': harness.LAB_LABEL},
            ], spec.run_id)
        with self.assertRaises(harness.RestoreRefused):
            harness.cleanup_plan([
                {'kind': 'container', 'name': spec.dest_container, 'run': 'bbbbbbbbbbbb', 'label': harness.LAB_LABEL},
            ], spec.run_id)

    def test_tampered_checksum_does_not_restore(self):
        spec = harness.sample_spec()
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / 'nexo-b12.dump'
            dump.write_bytes(b'PGDMP synthetic')
            manifest = Path(str(dump) + '.manifest.json')
            manifest.write_text('{}\n', encoding='utf-8')
            harness.write_checksum(dump)
            self.assertTrue(harness.checksum_valid(dump))
            manifest.write_text('{}\n ', encoding='utf-8')
            called = []
            with self.assertRaises(harness.RestoreRefused) as caught:
                harness.restore_authenticated(spec, dump, lambda: called.append('pg_restore'))
            self.assertIn('soma', str(caught.exception))
            self.assertEqual(called, [])
            self.assertFalse(harness.note_outcome('checksum-manifesto', False))
            with self.assertRaises(harness.RestoreRefused):
                harness.note_outcome('dump-manipulado', True)

    def test_success_requires_the_real_phases_and_both_refusals(self):
        self.assertFalse(harness.allow_success(['identidade'], []))
        self.assertFalse(harness.allow_success(list(harness.REQUIRED_PHASES), ['checksum-manifesto']))
        self.assertTrue(harness.allow_success(list(harness.REQUIRED_PHASES), list(harness.REFUSAL_KINDS)))
        self.assertFalse(harness.allow_success(list(harness.REQUIRED_PHASES), ['checksum-manifesto', 'dump-manipulado', 'ok']))

    def test_missing_docker_exits_without_commands(self):
        calls = []

        def which(_name):
            return None

        def run(argv, **_kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0)

        with self.assertRaises(SystemExit) as caught:
            harness.require_runtime(which=which, run=run)
        self.assertIn('Docker', str(caught.exception))
        self.assertEqual(calls, [])

    def test_docker_unavailable_exits_before_pull(self):
        calls = []

        def which(name):
            return '/usr/bin/' + name

        def run(argv, **_kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 1)

        with self.assertRaises(SystemExit):
            harness.require_runtime(which=which, run=run)
        self.assertEqual(calls, [['docker', 'info']])

    def test_stdout_json_includes_git_base(self):
        spec = harness.sample_spec()
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'restore-clean-host.json'
            previous = harness.REPORT
            harness.REPORT = report
            buffer = io.StringIO()
            try:
                with contextlib.redirect_stdout(buffer):
                    payload = harness._report(False, ['identidade'], [], spec, error='probe')
            finally:
                harness.REPORT = previous
            printed = json.loads(buffer.getvalue())
            saved = json.loads(report.read_text(encoding='utf-8'))
        self.assertEqual(printed['base'], payload['base'])
        self.assertEqual(printed['phases'], ['identidade'])
        self.assertEqual(printed['limits'], harness.LIMITS)
        self.assertEqual(printed['criterion'], 'B12')
        self.assertEqual(printed['secrets'], 'omitidos')
        self.assertEqual(saved['base'], payload['base'])
        self.assertNotIn(spec.aes_key, buffer.getvalue())
        self.assertNotIn(spec.source_owner_password, buffer.getvalue())

    def test_generated_identity_is_acceptable(self):
        spec = harness.new_spec()
        harness.assert_lab_identity(spec)
        self.assertNotEqual(spec.source_container, spec.dest_container)
        self.assertNotEqual(spec.source_owner_password, spec.dest_go_password)
        self.assertTrue(spec.dest_database.startswith('nexo_restore_check_'))


if __name__ == '__main__':
    unittest.main()
