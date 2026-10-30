"""Teste do diagnóstico de CI e relatórios de go_integration.py sem Docker/Go/rede."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CONTRATO_DIR = ROOT / 'tests' / 'contrato'
if str(CONTRATO_DIR) not in sys.path:
    sys.path.insert(0, str(CONTRATO_DIR))

SPEC = importlib.util.spec_from_file_location('go_integration', CONTRATO_DIR / 'go_integration.py')
go_integration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(go_integration)


def synthetic_failing_child(*args, **kwargs):
    # Processo filho sintético que emite JSONL e stderr fictícios com exit 2 (não-zero)
    # SEM Go, SEM Docker, SEM PostgreSQL, SEM rede.
    child_script = (
        'import sys, json\n'
        'entries = [\n'
        '  {"Time":"2026-10-30T12:00:00Z","Action":"run","Package":"apps/api-go/synthetic","Test":"TestSyntheticFailure"},\n'
        '  {"Time":"2026-10-30T12:00:00.01Z","Action":"output","Package":"apps/api-go/synthetic","Test":"TestSyntheticFailure","Output":"falha sintetica isolada\\n"},\n'
        '  {"Time":"2026-10-30T12:00:00.02Z","Action":"fail","Package":"apps/api-go/synthetic","Test":"TestSyntheticFailure","Elapsed":0.02},\n'
        '  {"Time":"2026-10-30T12:00:00.03Z","Action":"fail","Package":"apps/api-go/synthetic","Elapsed":0.03}\n'
        ']\n'
        'for entry in entries:\n'
        '    sys.stdout.write(json.dumps(entry) + "\\n")\n'
        'sys.stdout.flush()\n'
        'sys.stderr.write("stderr sintetico: falha simulada no processo filho\\n")\n'
        'sys.stderr.flush()\n'
        'sys.exit(2)\n'
    )
    return subprocess.run([sys.executable, '-c', child_script], check=True, text=True, capture_output=True)


def synthetic_passing_child(*args, **kwargs):
    # Processo filho sintético bem-sucedido com exit 0
    # SEM Go, SEM Docker, SEM PostgreSQL, SEM rede.
    child_script = (
        'import sys, json\n'
        'entries = [\n'
        '  {"Time":"2026-10-30T12:00:00Z","Action":"run","Package":"apps/api-go/synthetic","Test":"TestSyntheticPass"},\n'
        '  {"Time":"2026-10-30T12:00:00.01Z","Action":"pass","Package":"apps/api-go/synthetic","Test":"TestSyntheticPass","Elapsed":0.01},\n'
        '  {"Time":"2026-10-30T12:00:00.02Z","Action":"pass","Package":"apps/api-go/synthetic","Elapsed":0.02}\n'
        ']\n'
        'for entry in entries:\n'
        '    sys.stdout.write(json.dumps(entry) + "\\n")\n'
        'sys.stdout.flush()\n'
    )
    return subprocess.run([sys.executable, '-c', child_script], check=True, text=True, capture_output=True)


class GoIntegrationReportingTests(unittest.TestCase):
    def test_stdout_stderr_preservation_and_failure_propagation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_reports = Path(temp_dir) / 'relatorios'
            out_buf = io.StringIO()
            err_buf = io.StringIO()

            with redirect_stdout(out_buf), redirect_stderr(err_buf):
                with self.assertRaises(subprocess.CalledProcessError) as exc_ctx:
                    go_integration.run_go_tests(
                        runner=synthetic_failing_child,
                        reports_dir=temp_reports,
                        console=True,
                        go_version='go version go1.27.3 test/amd64',
                        postgres_version='PostgreSQL 16.8 (Synthetic Lab)',
                        lab_db={'container': 'nexo-go-tests-synthetic', 'port': 15689, 'database': 'nexo_test'},
                    )

            # 1. Propagação exata do erro/exit code não-zero
            self.assertEqual(exc_ctx.exception.returncode, 2)
            self.assertIn('TestSyntheticFailure', exc_ctx.exception.output)
            self.assertIn('stderr sintetico', exc_ctx.exception.stderr)

            # 2. Conservação da saída no console
            console_out = out_buf.getvalue()
            console_err = err_buf.getvalue()
            self.assertIn('TestSyntheticFailure', console_out)
            self.assertIn('stderr sintetico', console_err)

            # 3. Persistência dos artefatos
            jsonl_file = temp_reports / 'go-integration.jsonl'
            stderr_file = temp_reports / 'go-integration.stderr.log'
            summary_file = temp_reports / 'go-integration-summary.json'

            self.assertTrue(jsonl_file.is_file())
            self.assertTrue(stderr_file.is_file())
            self.assertTrue(summary_file.is_file())

            jsonl_text = jsonl_file.read_text(encoding='utf-8')
            stderr_text = stderr_file.read_text(encoding='utf-8')
            summary = json.loads(summary_file.read_text(encoding='utf-8'))

            # go-integration.jsonl preserva JSONL original do Go
            self.assertEqual(jsonl_text, console_out)
            self.assertIn('"Action": "fail"', jsonl_text)

            # go-integration.stderr.log preserva stderr
            self.assertEqual(stderr_text, "stderr sintetico: falha simulada no processo filho\n")

            # go-integration-summary.json registra status, falhas, versões e lab db sem segredos
            self.assertEqual(summary['status'], 'fail')
            self.assertFalse(summary['ok'])
            self.assertEqual(summary['exit_code'], 2)
            self.assertEqual(summary['go_version'], 'go version go1.27.3 test/amd64')
            self.assertEqual(summary['postgres_version'], 'PostgreSQL 16.8 (Synthetic Lab)')
            self.assertIn('apps/api-go/synthetic/TestSyntheticFailure', summary['nomes_falha'])
            self.assertEqual(summary['lab_database']['database'], 'nexo_test')
            self.assertEqual(summary['lab_database']['port'], 15689)
            self.assertEqual(summary['lab_database']['container'], 'nexo-go-tests-synthetic')

            # Sem DSNs, env ou segredos
            summary_str = json.dumps(summary).lower()
            self.assertNotIn('password', summary_str)
            self.assertNotIn('postgres://', summary_str)
            self.assertNotIn('secret', summary_str)

    def test_reporting_failure_preserves_original_subprocess_error(self):
        # Quando o destino do relatório é inválido (ex.: caminho é arquivo pré-existente)
        # e o subprocesso já falhou, a falha do subprocesso DEVE ser preservada (CalledProcessError)
        # e a falha de gravação deve ser visível no stderr.
        with tempfile.TemporaryDirectory() as temp_dir:
            file_as_reports_dir = Path(temp_dir) / 'relatorios_file'
            file_as_reports_dir.write_text('bloqueio intencional', encoding='utf-8')

            out_buf = io.StringIO()
            err_buf = io.StringIO()

            with redirect_stdout(out_buf), redirect_stderr(err_buf):
                with self.assertRaises(subprocess.CalledProcessError) as exc_ctx:
                    go_integration.run_go_tests(
                        runner=synthetic_failing_child,
                        reports_dir=file_as_reports_dir,
                        console=True,
                        go_version='go version go1.27.3 test/amd64',
                        postgres_version='PostgreSQL 16.8 (Synthetic Lab)',
                        lab_db={'container': 'nexo-go-tests-synthetic', 'port': 15689, 'database': 'nexo_test'},
                    )

            # O erro observado deve ser o CalledProcessError original, e NÃO FileExistsError
            self.assertEqual(exc_ctx.exception.returncode, 2)
            self.assertIn('TestSyntheticFailure', exc_ctx.exception.output)

            # Falha de relatório deve ser visível no stderr
            err_output = err_buf.getvalue()
            self.assertIn('go_integration: erro ao gravar relatorios de diagnostico', err_output)
            self.assertIn('stderr sintetico', err_output)

    def test_reporting_failure_on_successful_subprocess_does_not_silently_succeed(self):
        # Quando o subprocesso tem sucesso mas a gravação do relatório falha,
        # o erro de gravação deve ser propagado, não virando sucesso silencioso.
        with tempfile.TemporaryDirectory() as temp_dir:
            file_as_reports_dir = Path(temp_dir) / 'relatorios_file'
            file_as_reports_dir.write_text('bloqueio intencional', encoding='utf-8')

            out_buf = io.StringIO()
            err_buf = io.StringIO()

            with redirect_stdout(out_buf), redirect_stderr(err_buf):
                with self.assertRaises(OSError):
                    go_integration.run_go_tests(
                        runner=synthetic_passing_child,
                        reports_dir=file_as_reports_dir,
                        console=True,
                        go_version='go version go1.27.3 test/amd64',
                        postgres_version='PostgreSQL 16.8 (Synthetic Lab)',
                        lab_db={'container': 'nexo-go-tests-synthetic', 'port': 15689, 'database': 'nexo_test'},
                    )


if __name__ == '__main__':
    unittest.main()
