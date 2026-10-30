#!/usr/bin/env python3
"""Run PostgreSQL-dependent Go tests with a freshly prepared disposable DB."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

CONTRATO_DIR = Path(__file__).resolve().parent
if str(CONTRATO_DIR) not in sys.path:
    sys.path.insert(0, str(CONTRATO_DIR))

# Separate from other contract tests and never reuse an existing container.
os.environ['NEXO_CONTRATO_DB_CONTAINER'] = 'nexo-go-tests-' + uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT'] = '15689'

from lib import ROOT, DB_CONTAINER, DB_PORT, command, go, go_env, sql
from nativo import up

REPORTS_DIR = ROOT / 'tests' / 'contrato' / 'relatorios'


def get_go_version():
    try:
        proc = go('version', capture_output=True)
        return (proc.stdout or '').strip()
    except Exception:
        pass
    try:
        proc = subprocess.run(['go', 'version'], capture_output=True, text=True)
        return proc.stdout.strip()
    except Exception:
        return 'unknown'


def get_postgres_version():
    try:
        return sql('select version()', 'postgres').strip()
    except Exception:
        return 'unknown'


def parse_go_test_output(stdout_text):
    failures = []
    nomes_falha = []
    actions = {}
    total_lines = 0
    parse_errors = 0

    if stdout_text:
        for raw_line in stdout_text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            total_lines += 1
            try:
                entry = json.loads(line)
            except Exception:
                parse_errors += 1
                continue
            if isinstance(entry, dict):
                act = entry.get('Action')
                if act:
                    actions[act] = actions.get(act, 0) + 1
                if act == 'fail':
                    pkg = entry.get('Package', '')
                    test = entry.get('Test', '')
                    failures.append({'package': pkg, 'test': test})
                    if test:
                        nomes_falha.append(f"{pkg}/{test}" if pkg else test)
                    elif pkg:
                        nomes_falha.append(pkg)

    return {
        'failures': failures,
        'nomes_falha': nomes_falha,
        'actions': actions,
        'total_lines': total_lines,
        'parse_errors': parse_errors,
    }


def record_execution(stdout, stderr, returncode, go_version, postgres_version,
                     lab_db, reports_dir=None, console=True):
    if console:
        try:
            if stdout:
                sys.stdout.write(stdout)
                sys.stdout.flush()
            if stderr:
                sys.stderr.write(stderr)
                sys.stderr.flush()
        except Exception as ce:
            sys.stderr.write(f"go_integration: erro ao emitir console: {ce}\n")
            sys.stderr.flush()

    target_dir = reports_dir or REPORTS_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    jsonl_path = target_dir / 'go-integration.jsonl'
    stderr_path = target_dir / 'go-integration.stderr.log'
    summary_path = target_dir / 'go-integration-summary.json'

    jsonl_path.write_text(stdout or '', encoding='utf-8')
    stderr_path.write_text(stderr or '', encoding='utf-8')

    parsed = parse_go_test_output(stdout or '')

    # Dado não JSON ou erro de captura não vira PASS
    is_pass = (
        returncode == 0
        and len(parsed['failures']) == 0
        and parsed['parse_errors'] == 0
        and parsed['total_lines'] > 0
    )
    status = 'pass' if is_pass else 'fail'

    summary = {
        'status': status,
        'ok': is_pass,
        'exit_code': returncode,
        'failures': parsed['failures'],
        'nomes_falha': parsed['nomes_falha'],
        'failed_names': parsed['nomes_falha'],
        'actions': parsed['actions'],
        'total_lines': parsed['total_lines'],
        'parse_errors': parsed['parse_errors'],
        'go_version': go_version,
        'postgres_version': postgres_version,
        'versions': {
            'go': go_version,
            'postgres': postgres_version,
        },
        'lab_database': lab_db,
        'database_identity': lab_db,
    }

    summary_path.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return summary


def run_go_tests(runner=None, env=None, reports_dir=None, console=True,
                 go_version=None, postgres_version=None, lab_db=None):
    if runner is None:
        runner = go

    if lab_db is None:
        lab_db = {
            'container': DB_CONTAINER,
            'port': DB_PORT,
            'database': 'nexo_test',
        }

    if go_version is None:
        go_version = get_go_version()

    if postgres_version is None:
        postgres_version = get_postgres_version()

    if env is None:
        test_env = {}
    else:
        test_env = dict(env)
        if 'DATABASE_URL_GO' in env:
            test_env['NEXO_GO_TEST_DATABASE_URL'] = env['DATABASE_URL_GO']
        if 'DATABASE_URL_OWNER' in env:
            test_env['NEXO_GO_TEST_DATABASE_OWNER_URL'] = env['DATABASE_URL_OWNER']

    args = ('test', '-count=1', '-race', '-p', '1', '-json', './...')

    exc = None
    proc = None
    stdout = ''
    stderr = ''
    returncode = 0

    try:
        proc = runner(*args, env=test_env, capture_output=True)
        stdout = proc.stdout or ''
        stderr = proc.stderr or ''
        returncode = proc.returncode
    except subprocess.CalledProcessError as e:
        exc = e
        stdout = getattr(e, 'stdout', None) or getattr(e, 'output', '') or ''
        stderr = getattr(e, 'stderr', '') or ''
        returncode = e.returncode
    except Exception as e:
        exc = e
        stdout = getattr(e, 'stdout', None) or getattr(e, 'output', '') or ''
        stderr = getattr(e, 'stderr', '') or str(e)
        returncode = getattr(e, 'returncode', 1)

    summary = None
    report_exc = None
    try:
        summary = record_execution(
            stdout=stdout,
            stderr=stderr,
            returncode=returncode,
            go_version=go_version,
            postgres_version=postgres_version,
            lab_db=lab_db,
            reports_dir=reports_dir,
            console=console,
        )
    except Exception as e:
        sys.stderr.write(f"go_integration: erro ao gravar relatorios de diagnostico: {e}\n")
        sys.stderr.flush()
        report_exc = e

    if exc is not None:
        raise exc
    if returncode != 0:
        raise subprocess.CalledProcessError(returncode, cmd=['go', *args], output=stdout, stderr=stderr)
    if report_exc is not None:
        raise report_exc

    return summary


def main():
    try:
        up()
        sql('create database nexo_test', 'postgres')
        env = dict(go_env('nexo_test'), NEXO_DEMO_MODE='1',
                   NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
        go('build', '-o', 'bin/nexo-db', './cmd/nexo-db')
        for task in ['prepare', 'seed-demo']:
            command([str(ROOT/'apps/api-go/bin/nexo-db'), task], cwd=ROOT, env=env)
        sql("insert into pops(tenant_id,name) select id,'POP sintético A' from tenants;"
            "insert into pops(tenant_id,name) select id,'POP sintético B' from tenants;"
            "update contracts c set pop_id=(select id from pops p where p.tenant_id=c.tenant_id order by p.id limit 1)",
            'nexo_test')
        # Packages share a seeded disposable tenant. Jobs deliberately installs an
        # invalid tenant timezone; serialize packages so that fault injection cannot
        # contaminate finance receipts. Goroutine/race concurrency inside each test
        # remains enabled, including multi-worker receipt/idempotency tests.
        run_go_tests(env=dict(env, NEXO_GO_TEST_DATABASE_URL=env['DATABASE_URL_GO'],
                              NEXO_GO_TEST_DATABASE_OWNER_URL=env['DATABASE_URL_OWNER']))
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', DB_CONTAINER], capture_output=True)


if __name__ == '__main__':
    main()
