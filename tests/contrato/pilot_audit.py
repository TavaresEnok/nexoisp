#!/usr/bin/env python3
"""Focused pilot proof. Only owned B12 containers, synthetic data, no real NAS.

NEXO_B12_SUBNET optionally selects a free private /28 on pool-exhausted hosts.
NEXO_AUDIT_NODE may point to Node 22.23.4. Requires installed npm/e2e deps.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import urllib.parse

import restore_clean_host as h

OUT = h.ROOT / 'docs/auditoria-2026-11-06'


def database_env(env, database):
    result = dict(env)
    for key in ('DATABASE_URL_OWNER', 'DATABASE_URL_GO', 'DATABASE_URL_APP'):
        url = urllib.parse.urlsplit(result[key])
        result[key] = urllib.parse.urlunsplit(url._replace(path='/' + database))
    return result


def run():
    spec = h.new_spec()
    h.require_runtime()
    OUT.mkdir(parents=True, exist_ok=True)
    node = os.environ.get('NEXO_AUDIT_NODE', 'node')
    processes = []
    report = {'base': h._git_head(), 'ok': False, 'synthetic': True, 'checks': []}
    with tempfile.TemporaryDirectory(prefix=f'nexo-b12-{spec.run_id}-') as directory:
        spec.work_dir = directory
        work = Path(directory)
        try:
            if os.environ.get('NEXO_AUDIT_UI_ONLY') != '1':
                phases, refusals = [], []
                h._run_scenario(spec, dict(os.environ), phases, refusals)
                report['b12'] = {'phases': phases, 'refusals': refusals, 'limits': h.LIMITS}
                env = h.process_env(spec, 'destination', os.environ)
                cli = str(work / 'bin/nexo-db')
                verifier = work / 'verify.sh'
                verifier.write_text('#!/bin/sh\nexport NEXO_RESTORE_DATABASE="$1"\nexec ' + shlex.quote(cli) + ' verify-restore\n')
                verifier.chmod(0o700)
                dump = work / f'nexo-b12-{spec.run_id}.dump'
                stop, start = work / 'stopped', work / 'started'
                restore_env = database_env(env, 'nexo')
                restore_env.update(NEXO_DB_CONTAINER=spec.dest_container, NEXO_RESTORE_TARGET=spec.dest_container + '/nexo',
                                   NEXO_API_SERVICE_STOP='touch ' + shlex.quote(str(stop)),
                                   NEXO_API_SERVICE_START='touch ' + shlex.quote(str(start)),
                                   NEXO_RESTORE_VERIFY=str(verifier), NEXO_RESTORE_PREPARE='false')
                command = ['bash', 'scripts/backup.sh', 'restore', str(dump), '--yes']
                failed = subprocess.run(command, cwd=h.ROOT, env=restore_env, capture_output=True)
                assert failed.returncode != 0 and stop.exists() and not start.exists(), 'failed migration must leave writers stopped'
                report['checks'].append('restore real: falha de prepare deixa escritores parados')
                restore_env['NEXO_RESTORE_PREPARE'] = shlex.quote(cli) + ' prepare'
                h._checked(command, spec, env=restore_env, cwd=h.ROOT)
                assert start.exists()
                report['checks'].append('restore real: snapshot/RLS/chaves antes da substituição, prepare e retomada')

                # Clone only inside this run's exclusive cluster for PostgreSQL tests.
                h._psql(spec, spec.dest_container, 'postgres', 'create database nexo_test template nexo')
                test_env = database_env(env, 'nexo_test')
                test_env.update(h.toolchain_env(os.environ))
                test_env.update(NEXO_GO_TEST_DATABASE_URL=test_env['DATABASE_URL_GO'],
                                NEXO_GO_TEST_DATABASE_OWNER_URL=test_env['DATABASE_URL_OWNER'],
                                PG_REQUIRED='1', NEXO_CLOUD_PG_REQUIRED='1', CGO_ENABLED='1')
                args = ['go', 'test', '-count=1', '-race', '-p', '1', '-json', '-run',
                        'TestR06RestoreCloud|TestPilotPhaseChecks|TestRadiusDisconnectJournal|TestNoticeEnqueue|TestCloudNoticeGate|TestTenantFailureAndRestart|TestDisconnect|TestDelegatedIPv6',
                        './internal/db', './internal/outbound', './internal/jobs', './internal/radius']
                result = subprocess.run(args, cwd=h.ROOT / 'apps/api-go', env=test_env, capture_output=True, text=True)
                (OUT / 'go-focused.stderr.log').write_text(h.redact(result.stderr, spec.secrets()))
                (OUT / 'go-focused.jsonl').write_text(h.redact(result.stdout, spec.secrets()))
                events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
                skipped = [e.get('Test') for e in events if e.get('Action') == 'skip']
                assert result.returncode == 0 and not skipped, 'focused Go proof failed; inspect go-focused.jsonl'
                report['go'] = {'passed': [e['Test'] for e in events if e.get('Action') == 'pass' and e.get('Test')], 'skipped': skipped}
            else:
                h._create_network(spec, os.environ)
                h._create_volume(spec, spec.dest_volume, 'destination')
                h._create_container(spec, spec.dest_container, spec.dest_volume, spec.dest_port, spec.dest_owner_password, 'destination')
                h._wait_db(spec.dest_container)
                h._psql(spec, spec.dest_container, 'postgres', 'create database nexo')
                (work / 'bin').mkdir()
                for binary in ('api', 'nexo-db'):
                    h._checked(['go', 'build', '-o', str(work / 'bin' / binary), './cmd/' + binary], spec, env=h.toolchain_env(os.environ), cwd=h.ROOT / 'apps/api-go')
                env = database_env(h.process_env(spec, 'destination', os.environ), 'nexo')
                for command in ('prepare', 'seed-demo'):
                    h._checked([str(work / 'bin/nexo-db'), command], spec, env=env, cwd=h.ROOT)
                report['scope'] = 'browser only; prior backend proof is separate'
            # Browser always targets a new synthetic API, with all jobs disabled.
            browser_env = database_env(env, 'nexo')
            api, log, api_base = h._api(browser_env, spec, work / 'audit-api.log')
            processes.append((api, log))
            login = h._call(api_base, '/api/auth/login', body={'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True})
            token = login['json']['token']
            def call(path, body=None, token=None, method=None, **kwargs):
                return h._call(api_base, path, token=token, body=body, method=method)
            def api_call(path, body=None, base=None, method=None, **kwargs):
                return call(path, body, token=token, method=method)
            def sql(query, database='nexo_test'):
                if database != 'nexo_test':
                    raise h.RestoreRefused('HTTP fixture requested foreign database')
                return h._psql(spec, spec.dest_container, 'nexo', query)
            from work_order_attachments_contract import verify as attachments
            attachments(api_call, call, sql)
            from stock_quotations_contract import verify as stock
            stock(api_call, call, sql, [api_base, api_base])
            report['checks'].append('HTTP real: OS/anexos privados, POP/LGPD; cotação/estoque, concorrência em uma réplica e isolamento')

            port = h._distinct_ports(1)[0]
            web_log = (work / 'vite.log').open('w')
            web = subprocess.Popen([node, str(h.ROOT / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port)],
                                   cwd=h.ROOT / 'apps/web', env={**h.toolchain_env(os.environ), 'API_URL': api_base}, stdout=web_log, stderr=subprocess.STDOUT)
            processes.append((web, web_log))
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                if web.poll() is not None:
                    raise RuntimeError('Vite exited')
                try:
                    if h._call(base, '/')['status'] == 200:
                        break
                except Exception:
                    pass
                time.sleep(.1)
            h._checked([node, 'e2e/pilot-audit.mjs'], spec, env={**h.toolchain_env(os.environ), 'BASE': base}, cwd=h.ROOT)
            report['checks'].append('browser desktop e estreito: assinantes, faturas e atendimento; cookie/CSRF/API Go')
            report['ok'] = True
        finally:
            for process, log in reversed(processes):
                h._stop_process(process)
                log.close()
            h.cleanup(spec)
            (OUT / ('browser-run.json' if os.environ.get('NEXO_AUDIT_UI_ONLY') == '1' else 'proof.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': report['ok'], 'checks': report['checks']}, ensure_ascii=False))


if __name__ == '__main__':
    run()
